import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/brand/asael_mark.dart';
import '../application/session_controller.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _obscure = true;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    await ref
        .read(sessionControllerProvider.notifier)
        .signIn(_email.text, _password.text);
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionControllerProvider);
    return Scaffold(
      body: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 900;
          return Stack(
            children: [
              Positioned.fill(
                child: CustomPaint(painter: _SignalFieldPainter(context)),
              ),
              if (wide)
                Row(
                  children: [
                    Expanded(flex: 11, child: _DesktopStory()),
                    Expanded(
                      flex: 9,
                      child: _LoginPanel(
                        formKey: _formKey,
                        email: _email,
                        password: _password,
                        obscure: _obscure,
                        session: session,
                        onToggleObscure: () =>
                            setState(() => _obscure = !_obscure),
                        onSubmit: _submit,
                      ),
                    ),
                  ],
                )
              else
                SafeArea(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(24, 24, 24, 32),
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        minHeight: constraints.maxHeight - 80,
                      ),
                      child: _LoginPanel(
                        formKey: _formKey,
                        email: _email,
                        password: _password,
                        obscure: _obscure,
                        session: session,
                        onToggleObscure: () =>
                            setState(() => _obscure = !_obscure),
                        onSubmit: _submit,
                        mobile: true,
                      ),
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _DesktopStory extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(24),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(32),
        child: ColoredBox(
          color: scheme.primary,
          child: Stack(
            children: [
              Positioned.fill(
                child: CustomPaint(
                  painter: _ConstellationPainter(
                    scheme.onPrimary.withValues(alpha: .22),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(54),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _Entrance(
                      order: 0,
                      child: Row(
                        children: [
                          AsaelMark(
                            size: 42,
                            backgroundColor: scheme.onPrimary,
                            foregroundColor: scheme.primary,
                          ),
                          const SizedBox(width: 14),
                          AsaelWordmark(color: scheme.onPrimary),
                        ],
                      ),
                    ),
                    const Spacer(),
                    _Entrance(
                      order: 1,
                      child: Text(
                        'One place to\nmove work forward.',
                        style: Theme.of(context).textTheme.displayLarge
                            ?.copyWith(color: scheme.onPrimary, fontSize: 58),
                      ),
                    ),
                    const SizedBox(height: 24),
                    _Entrance(
                      order: 2,
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 430),
                        child: Text(
                          'Briefings, conversations, approvals, and evidence stay connected to the same private workspace.',
                          style: Theme.of(context).textTheme.bodyLarge
                              ?.copyWith(
                                color: scheme.onPrimary.withValues(alpha: .76),
                              ),
                        ),
                      ),
                    ),
                    const Spacer(),
                    _Entrance(
                      order: 3,
                      child: Row(
                        children: [
                          Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                              color: scheme.onPrimary,
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 10),
                          Text(
                            'Connected to Asael private cloud',
                            style: Theme.of(context).textTheme.labelLarge
                                ?.copyWith(
                                  color: scheme.onPrimary.withValues(
                                    alpha: .82,
                                  ),
                                ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _LoginPanel extends StatelessWidget {
  const _LoginPanel({
    required this.formKey,
    required this.email,
    required this.password,
    required this.obscure,
    required this.session,
    required this.onToggleObscure,
    required this.onSubmit,
    this.mobile = false,
  });

  final GlobalKey<FormState> formKey;
  final TextEditingController email;
  final TextEditingController password;
  final bool obscure;
  final AsyncValue<Object?> session;
  final VoidCallback onToggleObscure;
  final VoidCallback onSubmit;
  final bool mobile;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 430),
        child: Column(
          mainAxisSize: mobile ? MainAxisSize.max : MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (mobile) ...[
              _Entrance(
                order: 0,
                child: Row(
                  children: const [
                    AsaelMark(size: 42),
                    SizedBox(width: 14),
                    AsaelWordmark(),
                  ],
                ),
              ),
              const Spacer(),
            ],
            _Entrance(
              order: 1,
              child: Text(
                'Welcome back.',
                style: Theme.of(context).textTheme.displaySmall,
              ),
            ),
            const SizedBox(height: 10),
            _Entrance(
              order: 2,
              child: Text(
                'Sign in to continue with your workspace.',
                style: Theme.of(context).textTheme.bodyLarge
                    ?.copyWith(color: colors.onSurfaceVariant),
              ),
            ),
            const SizedBox(height: 34),
            _Entrance(
              order: 3,
              child: Form(
                key: formKey,
                child: Column(
                  children: [
                    TextFormField(
                      controller: email,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.email],
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(
                        labelText: 'Email',
                        prefixIcon: Icon(Icons.alternate_email_rounded),
                      ),
                      validator: (value) => value != null && value.contains('@')
                          ? null
                          : 'Enter a valid email',
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: password,
                      obscureText: obscure,
                      autofillHints: const [AutofillHints.password],
                      onFieldSubmitted: (_) => onSubmit(),
                      decoration: InputDecoration(
                        labelText: 'Password',
                        prefixIcon: const Icon(Icons.lock_outline_rounded),
                        suffixIcon: IconButton(
                          tooltip: obscure ? 'Show password' : 'Hide password',
                          onPressed: onToggleObscure,
                          icon: Icon(
                            obscure
                                ? Icons.visibility_outlined
                                : Icons.visibility_off_outlined,
                          ),
                        ),
                      ),
                      validator: (value) => (value?.length ?? 0) >= 8
                          ? null
                          : 'Use at least 8 characters',
                    ),
                  ],
                ),
              ),
            ),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 180),
              child: session.hasError
                  ? Padding(
                      key: ValueKey(session.error),
                      padding: const EdgeInsets.only(top: 14),
                      child: Semantics(
                        liveRegion: true,
                        child: Text(
                          session.error.toString(),
                          style: TextStyle(color: colors.error),
                        ),
                      ),
                    )
                  : const SizedBox.shrink(),
            ),
            const SizedBox(height: 20),
            _Entrance(
              order: 4,
              child: FilledButton(
                onPressed: session.isLoading ? null : onSubmit,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(session.isLoading ? 'Securing session…' : 'Continue'),
                    if (session.isLoading)
                      const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    else
                      const Icon(Icons.arrow_forward_rounded, size: 20),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 18),
            _Entrance(
              order: 5,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    Icons.lock_rounded,
                    size: 14,
                    color: colors.onSurfaceVariant,
                  ),
                  const SizedBox(width: 7),
                  Text(
                    'Encrypted session · protected on this device',
                    style: Theme.of(context).textTheme.bodySmall
                        ?.copyWith(color: colors.onSurfaceVariant),
                  ),
                ],
              ),
            ),
            if (mobile) const Spacer(flex: 2),
          ],
        ),
      ),
    );
  }
}

class _Entrance extends StatelessWidget {
  const _Entrance({required this.order, required this.child});

  final int order;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return child;
    return TweenAnimationBuilder<double>(
      duration: Duration(milliseconds: 420 + order * 55),
      curve: const Cubic(.16, 1, .3, 1),
      tween: Tween(begin: 0, end: 1),
      child: child,
      builder: (context, value, child) => Opacity(
        opacity: value,
        child: Transform.translate(
          offset: Offset(0, 18 * (1 - value)),
          child: child,
        ),
      ),
    );
  }
}

class _SignalFieldPainter extends CustomPainter {
  _SignalFieldPainter(BuildContext context)
    : color = Theme.of(context).colorScheme.primary,
      dark = Theme.of(context).brightness == Brightness.dark;

  final Color color;
  final bool dark;

  @override
  void paint(Canvas canvas, Size size) {
    final glow = Paint()
      ..shader =
          RadialGradient(
            colors: [
              color.withValues(alpha: dark ? .16 : .12),
              color.withValues(alpha: 0),
            ],
          ).createShader(
            Rect.fromCircle(
              center: Offset(size.width * .78, size.height * .1),
              radius: size.shortestSide * .74,
            ),
          );
    canvas.drawRect(Offset.zero & size, glow);
  }

  @override
  bool shouldRepaint(_SignalFieldPainter oldDelegate) =>
      oldDelegate.color != color || oldDelegate.dark != dark;
}

class _ConstellationPainter extends CustomPainter {
  const _ConstellationPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final line = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2;
    final dot = Paint()..color = color.withValues(alpha: .9);
    final points = <Offset>[
      Offset(size.width * .62, size.height * .12),
      Offset(size.width * .87, size.height * .25),
      Offset(size.width * .72, size.height * .44),
      Offset(size.width * .92, size.height * .62),
      Offset(size.width * .64, size.height * .79),
      Offset(size.width * .86, size.height * .92),
    ];
    final path = Path()..moveTo(points.first.dx, points.first.dy);
    for (final point in points.skip(1)) {
      path.lineTo(point.dx, point.dy);
    }
    canvas.drawPath(path, line);
    for (final point in points) {
      canvas.drawCircle(point, 3.2, dot);
    }
  }

  @override
  bool shouldRepaint(_ConstellationPainter oldDelegate) =>
      oldDelegate.color != color;
}
