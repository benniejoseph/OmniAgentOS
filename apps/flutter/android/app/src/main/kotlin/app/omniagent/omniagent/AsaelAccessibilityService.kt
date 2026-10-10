package app.omniagent.omniagent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Base64
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import kotlin.math.roundToInt

/** No bearer, network client, arbitrary shell, clipboard, or durable screen storage. */
class AsaelAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private var snapshot: Snapshot? = null
    private var lastScreenshotAt = 0L

    private data class Node(
        val id: String,
        val path: List<Int>,
        val role: String,
        val label: String,
        val value: String,
        val bounds: Rect,
        val enabled: Boolean,
        val editable: Boolean,
        val clickable: Boolean,
        val scrollable: Boolean,
    ) {
        fun publicValue(): Map<String, Any> = mapOf(
            "id" to id, "role" to role, "label" to label,
            "value" to value, "bounds" to rectangle(bounds),
            "enabled" to enabled, "editable" to editable,
            "clickable" to clickable, "scrollable" to scrollable,
        )
    }
    private data class Screen(
        val packageName: String,
        val appName: String,
        val windowId: Int,
        val displayId: Int,
        val bounds: Rect,
        val nodes: List<Node>,
        val fingerprint: String,
    )
    private data class Snapshot(
        val revision: String,
        val capturedAt: Long,
        val screen: Screen,
        val imageWidth: Int,
        val imageHeight: Int,
    )
    private class Refused(val code: String) : Exception(code)

    override fun onServiceConnected() {
        super.onServiceConnected()
        AndroidDeviceBridge.serviceConnected(this)
    }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (AndroidDeviceBridge.locked()) AndroidDeviceBridge.stopAll("device_locked")
        val prior = snapshot ?: return
        if ((event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
                event?.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) &&
            event.windowId != prior.screen.windowId) clearSnapshot()
    }
    override fun onInterrupt() {
        clearSnapshot()
        AndroidDeviceBridge.stopControl("accessibility_interrupted")
    }
    override fun onDestroy() {
        clearSnapshot()
        AndroidDeviceBridge.serviceDisconnected(this)
        super.onDestroy()
    }
    fun clearSnapshot() { snapshot = null }

    fun execute(
        action: String,
        input: Map<*, *>,
        taskAuthority: Boolean,
        current: () -> Boolean,
        completion: (Map<String, Any>) -> Unit,
    ) {
        var finished = false
        fun finish(value: Map<String, Any>) {
            if (finished) return
            finished = true
            completion(value)
        }
        fun refuse(code: String) { finish(AndroidDeviceBridge.failure(code)) }
        try {
            ensure(current())
            if (Build.VERSION.SDK_INT < 34) throw Refused("android_version_unsupported")
            when (action) {
                "list_apps" -> {
                    keys(input, setOf("query", "includeInstalled"))
                    val query = (input["query"] as? String)?.trim().orEmpty()
                    if (query.length > 120 || (input["includeInstalled"] != null && input["includeInstalled"] !is Boolean)) throw Refused("invalid_arguments")
                    val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                    @Suppress("DEPRECATION")
                    val apps = packageManager.queryIntentActivities(intent, 0)
                        .asSequence().map { it.activityInfo.packageName to it.loadLabel(packageManager).toString() }
                        .distinctBy { it.first }
                        .filter { !restrictedPackage(it.first, it.second) }
                        .filter { query.isEmpty() || it.first.contains(query, true) || it.second.contains(query, true) }
                        .take(80).map { mapOf("packageName" to it.first, "name" to clean(it.second, 160)) }.toList()
                    finish(success("Found ${apps.size} available apps.", mapOf("apps" to apps)))
                }
                "open_app" -> {
                    keys(input, setOf("packageName"))
                    val packageName = string(input, "packageName", 240)
                    if (!packageName.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+"))) throw Refused("invalid_arguments")
                    val name = appName(packageName)
                    if (restrictedPackage(packageName, name)) throw Refused("restricted_target")
                    val intent = packageManager.getLaunchIntentForPackage(packageName) ?: throw Refused("app_unavailable")
                    if (intent.component?.packageName != packageName) throw Refused("app_unavailable")
                    ensure(current())
                    clearSnapshot()
                    startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    handler.postDelayed({
                        if (!current()) { refuse("stopped"); return@postDelayed }
                        val opened = rootInActiveWindow?.let { root ->
                            try { root.packageName?.toString() == packageName } finally { root.recycle() }
                        } ?: false
                        finish(success(
                            if (opened) "Opened ${clean(name, 160)}." else "The app launch was requested; look at the phone to confirm it opened.",
                            mapOf("effectVerdict" to if (opened) "confirmed" else "unverifiable"),
                        ))
                    }, 450)
                }
                "observe" -> {
                    keys(input, setOf("presentScreenshot"))
                    if (input["presentScreenshot"] != null && input["presentScreenshot"] !is Boolean) throw Refused("invalid_arguments")
                    val screen = readScreen()
                    capture(screen, current) { image, error ->
                        if (error != null || image == null) { refuse(error ?: "screenshot_unavailable"); return@capture }
                        try {
                            ensure(current())
                            val refreshed = readScreen()
                            if (screen.fingerprint != refreshed.fingerprint) throw Refused("snapshot_stale")
                            val capturedAt = System.currentTimeMillis()
                            val revision = digest("${UUID.randomUUID()}:${screen.fingerprint}:$capturedAt")
                            val scaled = scaledImage(image)
                            image.recycle()
                            val jpeg = ByteArrayOutputStream()
                            scaled.compress(Bitmap.CompressFormat.JPEG, 72, jpeg)
                            val bytes = jpeg.toByteArray()
                            if (bytes.size > 1_300_000) { scaled.recycle(); throw Refused("screen_too_complex") }
                            val accepted = Snapshot(revision, capturedAt, screen, scaled.width, scaled.height)
                            scaled.recycle()
                            snapshot = accepted
                            val observation = linkedMapOf<String, Any>(
                                "capturedAt" to Instant.ofEpochMilli(capturedAt).toString(),
                                "snapshotRevision" to revision,
                                "frontmostApplication" to mapOf("name" to clean(screen.appName, 160), "packageName" to screen.packageName),
                                "window" to mapOf("id" to screen.windowId, "displayId" to screen.displayId, "bounds" to rectangle(screen.bounds)),
                                "elements" to screen.nodes.map(Node::publicValue),
                                "accessibilitySnapshot" to screen.nodes.joinToString("\n") { "${it.id} ${it.role}: ${it.label} ${it.value}" }.take(24000),
                            )
                            // Screenshots are ephemeral model input; presentScreenshot controls
                            // the Flutter preview, not the model's visual grounding.
                            observation["screenshot"] = mapOf(
                                "mimeType" to "image/jpeg", "dataBase64" to Base64.encodeToString(bytes, Base64.NO_WRAP),
                                "widthPixels" to accepted.imageWidth, "heightPixels" to accepted.imageHeight,
                                "coordinateSpace" to "screenshot_pixel",
                            )
                            finish(success("Looked at ${clean(screen.appName, 160)}.", observation = observation))
                        } catch (error: Exception) {
                            if (!image.isRecycled) image.recycle()
                            refuse((error as? Refused)?.code ?: "observation_unavailable")
                        }
                    }
                }
                "home" -> {
                    keys(input, setOf("snapshotRevision"))
                    val revision = input["snapshotRevision"]
                    if (revision != null) validateSnapshot(input)
                    else {
                        // Safe bootstrap out of Asael's own FLAG_SECURE window.
                        // No screen contents are disclosed by a global Home action.
                        val root = rootInActiveWindow ?: throw Refused("screen_unavailable")
                        try {
                            val target = root.packageName?.toString() ?: throw Refused("screen_unavailable")
                            if (target != packageName && restrictedPackage(target, appName(target))) throw Refused("restricted_target")
                        } finally { root.recycle() }
                    }
                    ensure(current())
                    clearSnapshot()
                    val accepted = performGlobalAction(GLOBAL_ACTION_HOME)
                    finish(success("Requested the phone's Home screen. Look again before the next action.", mapOf("effectVerdict" to if (accepted) "unverifiable" else "suspected_noop")))
                }
                "press", "tap", "type", "scroll", "swipe", "back" -> {
                    val allowed = when (action) {
                        "press" -> setOf("snapshotRevision", "elementId")
                        "tap" -> setOf("snapshotRevision", "coordinateSpace", "x", "y")
                        "type" -> setOf("snapshotRevision", "elementId", "text")
                        "scroll" -> setOf("snapshotRevision", "elementId", "direction", "amount")
                        "swipe" -> setOf("snapshotRevision", "coordinateSpace", "startX", "startY", "endX", "endY", "durationMs")
                        else -> setOf("snapshotRevision")
                    }
                    keys(input, allowed)
                    val accepted = validateSnapshot(input)
                    // A fresh secure-window check precedes every effect. A window
                    // becoming protected after observation never inherits access.
                    capture(accepted.screen, current) { proof, error ->
                        proof?.recycle()
                        if (error != null) { refuse(error); return@capture }
                        try {
                            ensure(current())
                            val verified = validateSnapshot(input)
                            performAction(action, input, verified, taskAuthority, current, ::finish)
                        } catch (failure: Exception) {
                            refuse((failure as? Refused)?.code ?: "action_unavailable")
                        }
                    }
                }
                else -> throw Refused("unsupported_action")
            }
        } catch (error: Exception) {
            refuse((error as? Refused)?.code ?: "action_unavailable")
        }
    }

    private fun performAction(
        action: String, input: Map<*, *>, accepted: Snapshot, taskAuthority: Boolean,
        current: () -> Boolean, finish: (Map<String, Any>) -> Unit,
    ) {
        val screen = accepted.screen
        fun complete(dispatched: Boolean, details: Map<String, Any> = emptyMap()) {
            handler.postDelayed({
                if (!current()) { finish(AndroidDeviceBridge.failure("stopped")); return@postDelayed }
                val after = try { readScreen().fingerprint } catch (_: Exception) { null }
                val verdict = if (!dispatched) "suspected_noop" else if (after == null) "unverifiable"
                    else if (after != screen.fingerprint) "confirmed" else "suspected_noop"
                finish(success(
                    if (verdict == "confirmed") "The phone screen changed after the action."
                    else "The action was requested; look again to confirm the result.",
                    mapOf("effectVerdict" to verdict) + details,
                ))
            }, 300)
        }
        if (action == "back") {
            ensure(current()); clearSnapshot(); complete(performGlobalAction(GLOBAL_ACTION_BACK)); return
        }
        if (action == "swipe") {
            val start = point(input, "startX", "startY", accepted)
            val end = point(input, "endX", "endY", accepted)
            val duration = number(input, "durationMs").toLong()
            if (duration !in 100..1000 || (start.first == end.first && start.second == end.second)) throw Refused("invalid_arguments")
            if (taskAuthority) throw Refused("task_authority_refused")
            // Require a known scrollable region, rather than blindly gesturing
            // over a dismiss/delete affordance or a system navigation edge.
            val node = screen.nodes.filter { it.scrollable && it.enabled && it.bounds.contains(start.first.toInt(), start.second.toInt()) && it.bounds.contains(end.first.toInt(), end.second.toInt()) }
                .minByOrNull { it.bounds.width().toLong() * it.bounds.height() } ?: throw Refused("element_unavailable")
            validateNodeLabel(node, taskAuthority)
            ensure(current()); clearSnapshot()
            gesture(start, end, duration) { complete(it) }
            return
        }
        val node = if (action == "tap") {
            val point = point(input, "x", "y", accepted)
            screen.nodes.filter { it.enabled && (it.clickable || it.editable) && it.bounds.contains(point.first.toInt(), point.second.toInt()) }
                .minByOrNull { it.bounds.width().toLong() * it.bounds.height() } ?: throw Refused("element_unavailable")
        } else {
            val id = string(input, "elementId", 120)
            screen.nodes.firstOrNull { it.id == id } ?: throw Refused("element_unavailable")
        }
        validateNodeLabel(node, taskAuthority)
        val live = resolveNode(node, screen) ?: throw Refused("snapshot_stale")
        try {
            if (!live.refresh() || sensitive(live) || !live.isEnabled) throw Refused("restricted_target")
            val text = if (action == "type") string(input, "text", 8000) else null
            if (text != null && (SECRET.containsMatchIn(text) || text.any { it.code < 32 && it != '\n' && it != '\t' })) throw Refused("restricted_target")
            ensure(current())
            clearSnapshot()
            val performed = when (action) {
                "press" -> {
                    if (!node.clickable) throw Refused("element_unavailable")
                    live.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                }
                "type" -> {
                    if (!node.editable) throw Refused("element_unavailable")
                    live.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
                        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
                    })
                }
                "scroll" -> {
                    if (!node.scrollable) throw Refused("element_unavailable")
                    val amount = if (input.containsKey("amount")) number(input, "amount") else 1.0
                    if (amount < 1 || amount > 5 || amount != amount.toInt().toDouble()) throw Refused("invalid_arguments")
                    val direction = string(input, "direction", 10)
                    val scroll = when (direction) {
                        "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
                        "down" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id
                        "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
                        "right" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
                        else -> throw Refused("invalid_arguments")
                    }
                    // One bounded viewport per observation; amount is a requested
                    // maximum, never permission to replay after the screen changes.
                    val scrolled = live.performAction(scroll)
                    complete(scrolled, mapOf("requestedAmount" to amount.toInt(), "completedAmount" to if (scrolled) 1 else 0))
                    return
                }
                "tap" -> {
                    val point = point(input, "x", "y", accepted)
                    gesture(point, point, 70) { complete(it) }
                    return
                }
                else -> throw Refused("unsupported_action")
            }
            complete(performed)
        } finally { live.recycle() }
    }

    private fun gesture(start: Pair<Float, Float>, end: Pair<Float, Float>, duration: Long, complete: (Boolean) -> Unit) {
        val path = Path().apply { moveTo(start.first, start.second); if (start != end) lineTo(end.first, end.second) }
        var called = false
        fun finish(value: Boolean) { if (!called) { called = true; complete(value) } }
        val accepted = dispatchGesture(
            GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration)).build(),
            object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) { finish(true) }
                override fun onCancelled(gestureDescription: GestureDescription?) { finish(false) }
            }, handler,
        )
        if (!accepted) finish(false)
    }

    private fun validateSnapshot(input: Map<*, *>): Snapshot {
        val revision = string(input, "snapshotRevision", 64)
        if (!revision.matches(Regex("[a-f0-9]{64}"))) throw Refused("invalid_arguments")
        val known = snapshot ?: throw Refused("snapshot_stale")
        if (known.revision != revision || System.currentTimeMillis() - known.capturedAt > 30_000) throw Refused("snapshot_stale")
        val current = readScreen()
        if (current.fingerprint != known.screen.fingerprint) throw Refused("snapshot_stale")
        return known
    }

    private fun readScreen(): Screen {
        if (AndroidDeviceBridge.locked()) throw Refused("device_locked")
        val root = rootInActiveWindow ?: throw Refused("screen_unavailable")
        try {
            val target = root.packageName?.toString() ?: throw Refused("screen_unavailable")
            val name = appName(target)
            if (restrictedPackage(target, name)) throw Refused("restricted_target")
            val window = root.window ?: throw Refused("screen_unavailable")
            val windowBounds = Rect()
            val displayId: Int
            try {
                if (window.type != AccessibilityWindowInfo.TYPE_APPLICATION || !window.isActive) throw Refused("restricted_target")
                window.getBoundsInScreen(windowBounds)
                displayId = window.displayId
                if (displayId != 0 || windowBounds.left < 0 || windowBounds.top < 0 || windowBounds.width() <= 0 || windowBounds.height() <= 0) throw Refused("screen_unavailable")
            } finally { window.recycle() }
            val nodes = mutableListOf<Node>()
            var visited = 0
            var textSize = 0
            fun walk(element: AccessibilityNodeInfo, path: List<Int>, depth: Int) {
                if (depth > 24 || ++visited > 600) throw Refused("screen_too_complex")
                if (!element.isVisibleToUser) return
                if (sensitive(element)) throw Refused("restricted_target")
                val rawLabel = element.contentDescription?.toString().orEmpty()
                val rawValue = element.text?.toString().orEmpty()
                val screenText = "$rawLabel $rawValue".trim()
                if (SECRET.containsMatchIn(screenText) || SECURITY_SCREEN.containsMatchIn(screenText)) throw Refused("restricted_target")
                if ((element.isClickable || element.isEditable) && SECURITY_CONTROL.containsMatchIn(screenText)) throw Refused("restricted_target")
                val bounds = Rect().also(element::getBoundsInScreen)
                if (bounds.isEmpty || !bounds.intersect(windowBounds)) return
                if (element.isClickable || element.isEditable || element.isScrollable || rawLabel.isNotBlank() || rawValue.isNotBlank()) {
                    if (nodes.size >= 160) throw Refused("screen_too_complex")
                    val label = clean(rawLabel.ifBlank { if (!element.isEditable) rawValue else element.hintText?.toString().orEmpty() }, 240)
                    val value = clean(if (element.isEditable) rawValue else "", 500)
                    textSize += label.length + value.length
                    if (textSize > 20000) throw Refused("screen_too_complex")
                    nodes.add(Node(
                        "android_node_${nodes.size + 1}", path,
                        clean(element.className?.toString()?.substringAfterLast('.') ?: "View", 80),
                        label, value, bounds, element.isEnabled, element.isEditable, element.isClickable, element.isScrollable,
                    ))
                }
                for (index in 0 until element.childCount.coerceAtMost(200)) {
                    val child = element.getChild(index) ?: continue
                    try { walk(child, path + index, depth + 1) } finally { child.recycle() }
                }
                if (element.childCount > 200) throw Refused("screen_too_complex")
            }
            walk(root, emptyList(), 0)
            val fingerprint = digest("$target:${root.windowId}:$displayId:${windowBounds.flattenToString()}:${JSONArray(nodes.map(Node::publicValue))}")
            return Screen(target, name, root.windowId, displayId, windowBounds, nodes, fingerprint)
        } finally { root.recycle() }
    }

    private fun resolveNode(node: Node, screen: Screen): AccessibilityNodeInfo? {
        var current = rootInActiveWindow ?: return null
        if (current.packageName?.toString() != screen.packageName || current.windowId != screen.windowId) { current.recycle(); return null }
        for (index in node.path) {
            val next = current.getChild(index)
            current.recycle()
            if (next == null) return null
            current = next
        }
        val bounds = Rect().also(current::getBoundsInScreen)
        if (!bounds.intersect(screen.bounds) || bounds != node.bounds) { current.recycle(); return null }
        return current
    }

    private fun capture(screen: Screen, current: () -> Boolean, completion: (Bitmap?, String?) -> Unit) {
        val delay = (lastScreenshotAt + 360 - System.currentTimeMillis()).coerceAtLeast(0)
        handler.postDelayed({
            if (!current()) { completion(null, "stopped"); return@postDelayed }
            if (Build.VERSION.SDK_INT < 34) { completion(null, "android_version_unsupported"); return@postDelayed }
            lastScreenshotAt = System.currentTimeMillis()
            try {
                takeScreenshotOfWindow(screen.windowId, mainExecutor, object : TakeScreenshotCallback {
                    override fun onSuccess(result: ScreenshotResult) {
                        val buffer = result.hardwareBuffer
                        try {
                            if (!current()) { completion(null, "stopped"); return }
                            val hardware = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace)
                            val bitmap = hardware?.copy(Bitmap.Config.ARGB_8888, false)
                            hardware?.recycle()
                            if (bitmap == null) completion(null, "screenshot_unavailable") else completion(bitmap, null)
                        } finally { buffer.close() }
                    }
                    override fun onFailure(errorCode: Int) {
                        completion(null, if (errorCode == ERROR_TAKE_SCREENSHOT_SECURE_WINDOW) "secure_screen" else "screenshot_unavailable")
                    }
                })
            } catch (_: Exception) { completion(null, "screenshot_unavailable") }
        }, delay)
    }

    private fun point(input: Map<*, *>, xKey: String, yKey: String, snapshot: Snapshot): Pair<Float, Float> {
        if (input["coordinateSpace"] != "screenshot_pixel") throw Refused("invalid_arguments")
        val x = number(input, xKey)
        val y = number(input, yKey)
        if (x < 0 || y < 0 || x >= snapshot.imageWidth || y >= snapshot.imageHeight) throw Refused("invalid_arguments")
        val bounds = snapshot.screen.bounds
        return (bounds.left + x * bounds.width() / snapshot.imageWidth).toFloat() to
            (bounds.top + y * bounds.height() / snapshot.imageHeight).toFloat()
    }
    private fun validateNodeLabel(node: Node, taskAuthority: Boolean) {
        if (!node.enabled || SECURITY_CONTROL.containsMatchIn("${node.label} ${node.value}".trim())) throw Refused("restricted_target")
        if (taskAuthority && CONSEQUENT.containsMatchIn("${node.label} ${node.value}")) throw Refused("task_authority_refused")
    }
    private fun sensitive(node: AccessibilityNodeInfo): Boolean {
        if (node.isPassword || (Build.VERSION.SDK_INT >= 34 && node.isAccessibilityDataSensitive)) return true
        val variation = node.inputType and InputType.TYPE_MASK_VARIATION
        return variation == InputType.TYPE_TEXT_VARIATION_PASSWORD || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
            variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
            (node.inputType and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
    }
    private fun appName(target: String): String = try {
        @Suppress("DEPRECATION")
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(target, 0)).toString()
    } catch (_: Exception) { target }
    private fun restrictedPackage(target: String, name: String): Boolean =
        target == packageName || target == "android" || RESTRICTED_PACKAGE.containsMatchIn(target) || RESTRICTED_APP_NAME.containsMatchIn(name)

    companion object {
        private val RESTRICTED_PACKAGE = Regex("(?i)(^com\\.android\\.(systemui|settings|permissioncontroller|packageinstaller)|^com\\.google\\.android\\.(permissioncontroller|packageinstaller)|(^|[._])(bank|banking|wallet|pay|payments|password|keychain|authenticator|settings|security|knox|securefolder)([._]|$)|bitwarden|lastpass|onepassword|1password|dashlane|keepass|paypal|revolut|monzo|starling|hdfc|icici|sbi\\.|axisbank|kotak|chase|citi\\.|hsbc|barclays|lloyds|natwest|stripe|squareup|phonepe|paytm|cred\\.|gpay|spay|samsungpay|cryptowallet|coinbase|binance)")
        private val RESTRICTED_APP_NAME = Regex("(?i)\\b(bank|banking|wallet|password|authenticator|security|settings|payment|payments|secure folder)\\b")
        private val SECURITY_CONTROL = Regex("(?i)\\b(password|passcode|one[ -]time (code|password)|verification code|security code|credit card|card number|cvv|fingerprint|biometric|face id|allow access|allow permission|don't allow|grant access|approve|authorize|authorise|confirm payment|send money|transfer funds)\\b|^(allow|deny|install|uninstall|enable accessibility)$")
        private val SECURITY_SCREEN = Regex("(?i)\\b(account balance|available balance|routing number|sort code|iban|bank account|credit card|transfer funds|online banking|one[ -]time (code|password)|verification code)\\b")
        private val CONSEQUENT = Regex("(?i)\\b(send|submit|delete|remove|buy|purchase|pay|post|publish|invite|share|upload|confirm|save|accept|commit|merge|execute|call|dial|unsubscribe|cancel subscription)\\b")
        private val SECRET = Regex("(?i)(\\bBearer\\s+[A-Za-z0-9._-]{12,}|\\bsk-[A-Za-z0-9_-]{12,}|\\b(?:api[_ -]?key|access[_ -]?token|secret)\\s*[:=]\\s*\\S{8,})")
        private fun clean(text: String, limit: Int): String = SECRET.replace(text, "[redacted]")
            .replace(Regex("[\\u0000-\\u001f\\u007f]+"), " ").trim().take(limit)
        private fun digest(text: String): String = MessageDigest.getInstance("SHA-256")
            .digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        private fun rectangle(rect: Rect): Map<String, Int> = mapOf("x" to rect.left, "y" to rect.top, "width" to rect.width(), "height" to rect.height())
        private fun scaledImage(bitmap: Bitmap): Bitmap {
            val scale = (1440.0 / maxOf(bitmap.width, bitmap.height)).coerceAtMost(1.0)
            if (scale == 1.0) return bitmap.copy(Bitmap.Config.ARGB_8888, false)
            return Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).roundToInt().coerceAtLeast(1), (bitmap.height * scale).roundToInt().coerceAtLeast(1), true)
        }
        private fun keys(input: Map<*, *>, allowed: Set<String>) {
            if (input.keys.any { it !is String || it !in allowed }) throw Refused("invalid_arguments")
        }
        private fun string(input: Map<*, *>, key: String, maximum: Int, allowEmpty: Boolean = false): String {
            val value = input[key] as? String ?: throw Refused("invalid_arguments")
            if ((!allowEmpty && value.isBlank()) || value.length > maximum || value.indexOf('\u0000') >= 0) throw Refused("invalid_arguments")
            return value
        }
        private fun number(input: Map<*, *>, key: String): Double {
            val value = (input[key] as? Number)?.toDouble() ?: throw Refused("invalid_arguments")
            if (!value.isFinite()) throw Refused("invalid_arguments")
            return value
        }
        private fun ensure(value: Boolean) { if (!value) throw Refused("stopped") }
        private fun success(summary: String, data: Map<String, Any> = emptyMap(), observation: Map<String, Any>? = null): Map<String, Any> {
            val result = linkedMapOf<String, Any>("summary" to summary, "data" to data)
            if (observation != null) result["observation"] = observation
            return mapOf("outcome" to "succeeded", "result" to result)
        }
    }
}
