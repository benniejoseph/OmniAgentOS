"use client";
import { useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Download,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { PrivateMediaPreview } from "@/components/media/private-media-preview";
import {
  type StudioAsset,
  type StudioGraph,
  type StudioIssue,
  type StudioNode,
  type StudioNodeRun,
  type StudioScope,
  studioAssetUrl,
} from "@/lib/studio/contracts";
import {
  renderStudioProviderPrompt,
  type StudioCapability,
  type StudioParameter,
} from "@/lib/studio/capabilities";
import {
  connectionIssue,
  effectivePrompt,
  getNodePorts,
  switchNodeCapability,
} from "@/lib/studio/graph";
import {
  enrichStudioAsset,
  nodeLabels,
  readableModelChanges,
  statusLabel,
} from "./state";
import styles from "./studio.module.css";

export function StudioInspector({
  node,
  graph,
  capabilities,
  assets,
  run,
  historicalAssets,
  selectableOutputIds,
  stale,
  upstreamResults,
  staleNodeIds,
  issues,
  disabled,
  busy,
  onNode,
  onGraph,
  onUpload,
  onReuse,
  onRun,
  onNotice,
}: {
  node?: StudioNode;
  graph: StudioGraph;
  capabilities: StudioCapability[];
  assets: StudioAsset[];
  run?: StudioNodeRun;
  historicalAssets: StudioAsset[];
  selectableOutputIds: string[];
  stale: boolean;
  upstreamResults: Record<string, { outputAssets: StudioAsset[] }>;
  staleNodeIds: ReadonlySet<string>;
  issues: StudioIssue[];
  disabled: boolean;
  busy: boolean;
  onNode: (node: StudioNode) => void;
  onGraph: (graph: StudioGraph) => void;
  onUpload: (file: File) => Promise<void>;
  onReuse: (asset: StudioAsset) => void;
  onRun: (scope: StudioScope) => void;
  onNotice: (message: string, kind?: "model-change") => void;
}) {
  const upload = useRef<HTMLInputElement>(null);
  const [connectFrom, setConnectFrom] = useState("");
  const [connectTo, setConnectTo] = useState("");
  if (!node)
    return (
      <>
        <h2 className={styles.sectionHeading}>Node inspector</h2>
        <p className={styles.support}>
          Select a node to write its prompt, connect references, configure a
          model and inspect results.
        </p>
        <p className={styles.support}>
          Select a connection to remove it without removing its nodes.
        </p>
      </>
    );
  const capability = capabilities.find(
    (c) => c.id === node.config.capabilityId,
  );
  const generator = node.type === "image" || node.type === "video";
  const connectedPrompt = graph.edges.some(
    (e) => e.target === node.id && e.targetPort === "prompt",
  );
  const selectedAsset = assets.find((a) => a.id === node.config.assetId);
  const outputs = [
    ...new Map(
      [...(run?.outputAssets || []), ...historicalAssets].map((a) => [a.id, a]),
    ).values(),
  ].map((asset) => enrichStudioAsset(asset, assets));
  const references = graph.edges
    .filter((e) => e.target === node.id)
    .sort((a, b) => a.order - b.order);
  const resolvedReferences = Object.fromEntries(
    references
      .filter((edge) => edge.targetPort !== "prompt")
      .map((edge) => {
        const source = graph.nodes.find((value) => value.id === edge.source);
        const candidates =
          source?.type === "asset"
            ? assets.filter(
                (asset) =>
                  asset.id === source.config.assetId &&
                  (!source.config.assetVersion ||
                    asset.contentSha256 === source.config.assetVersion),
              )
            : upstreamResults[edge.source]?.outputAssets || [];
        const resolved =
          (edge.sourcePort === "selected" || edge.sourcePort === "video") &&
          candidates.length > 1
            ? candidates.filter(
                (asset) => asset.id === source?.config.selectedOutputId,
              )
            : candidates;
        return [edge.id, resolved];
      }),
  );
  const inputs = getNodePorts(node, capabilities).filter(
    (p) => p.direction === "input",
  );
  const sourceOptions = graph.nodes
    .filter((n) => n.id !== node.id)
    .flatMap((n) =>
      getNodePorts(n, capabilities)
        .filter((p) => p.direction === "output")
        .map((p) => ({
          key: JSON.stringify([n.id, p.id]),
          label: `${n.title} · ${p.label}`,
        })),
    );
  function config(patch: Partial<StudioNode["config"]>) {
    if (node) onNode({ ...node, config: { ...node.config, ...patch } });
  }
  function connect() {
    if (!node || !connectFrom || !connectTo) return;
    const [source, sourcePort] = JSON.parse(connectFrom) as string[];
    const edge = {
      id: crypto.randomUUID(),
      source,
      sourcePort,
      target: node.id,
      targetPort: connectTo,
      order: graph.edges.length,
    };
    const error = connectionIssue(graph, edge, capabilities);
    if (error) {
      onNotice(error.message);
      return;
    }
    onGraph({ ...graph, edges: [...graph.edges, edge] });
    setConnectFrom("");
    setConnectTo("");
  }
  return (
    <>
      <div className={styles.panelHeading}>
        <h2>{nodeLabels[node.type]}</h2>
        {capability?.demo ? (
          <span className={styles.demo}>Demo fixtures</span>
        ) : null}
      </div>
      <label className={styles.field}>
        Node name
        <input
          className={styles.input}
          value={node.title}
          maxLength={160}
          disabled={disabled}
          onChange={(e) => onNode({ ...node, title: e.target.value })}
        />
      </label>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={node.enabled}
          disabled={disabled}
          onChange={(e) => onNode({ ...node, enabled: e.target.checked })}
        />
        Include this node in flow execution
      </label>
      {node.type === "prompt" || node.type === "note" || generator ? (
        <label className={styles.field}>
          {node.type === "note"
            ? "Note"
            : connectedPrompt
              ? "Local prompt (used when disconnected)"
              : "Prompt"}
          <textarea
            className={styles.textarea}
            value={node.config.prompt || ""}
            rows={6}
            maxLength={8000}
            disabled={disabled}
            onChange={(e) => config({ prompt: e.target.value })}
            placeholder={
              node.type === "note"
                ? "Instructions for this flow"
                : "Describe the subject, setting and desired result…"
            }
          />
          {connectedPrompt ? (
            <small>The connected Prompt node supplies the primary text.</small>
          ) : null}
        </label>
      ) : null}
      {generator ? (
        <>
          <label className={styles.field}>
            Model and operation
            <select
              className={styles.select}
              value={node.config.capabilityId || ""}
              disabled={disabled}
              onChange={(e) => {
                const next = capabilities.find((c) => c.id === e.target.value);
                if (!next) return;
                const switched = switchNodeCapability(node, next);
                onNode(switched.node);
                onNotice(
                  switched.changes.length
                    ? readableModelChanges(switched.changes, [
                        ...(capability?.parameters || []),
                        ...next.parameters,
                      ]).join(" ")
                    : "Model changed. Check that its reference connections remain compatible.",
                  "model-change",
                );
              }}
            >
              <option value="">Choose a model</option>
              {capabilities
                .filter((c) => c.mediaKind === node.type)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} · {c.demo ? "simulated" : c.model}
                    {!c.available ? " · needs setup" : ""}
                  </option>
                ))}
            </select>
          </label>
          {capability ? (
            <>
              <p className={styles.support}>
                {capability.demo
                  ? "These are fixed demonstration files. Prompts and settings exercise the workflow but do not generate new media."
                  : `${capability.model} · ${capability.pricing.note}`}
              </p>
              {!capability.available ? (
                <p className={styles.error}>
                  {capability.unavailableReason}{" "}
                  <a href="/app/settings">Open model settings</a>
                </p>
              ) : null}
            </>
          ) : null}
          <label className={styles.field}>
            Additional instruction
            <textarea
              className={styles.textarea}
              value={node.config.instruction || ""}
              rows={3}
              maxLength={4000}
              disabled={disabled}
              onChange={(e) => config({ instruction: e.target.value })}
            />
            <small>
              Appended once after the primary prompt, separated by a blank line.
            </small>
          </label>
          {capability?.parameters
            .filter((p) =>
              [
                "aspectRatio",
                "resolution",
                "imageSize",
                "outputCount",
              ].includes(p.key),
            )
            .map((p) => (
              <ParameterField
                key={p.key}
                field={p}
                value={node.config.parameters[p.key] ?? p.default}
                disabled={disabled}
                onChange={(value) =>
                  config({
                    parameters: { ...node.config.parameters, [p.key]: value },
                  })
                }
              />
            ))}
          {capability?.parameters.some(
            (p) =>
              ![
                "aspectRatio",
                "resolution",
                "imageSize",
                "outputCount",
              ].includes(p.key),
          ) ? (
            <details className={styles.details}>
              <summary>Advanced parameters</summary>
              {capability.parameters
                .filter(
                  (p) =>
                    ![
                      "aspectRatio",
                      "resolution",
                      "imageSize",
                      "outputCount",
                    ].includes(p.key),
                )
                .map((p) => (
                  <ParameterField
                    key={p.key}
                    field={p}
                    value={node.config.parameters[p.key] ?? p.default}
                    disabled={disabled}
                    onChange={(value) =>
                      config({
                        parameters: {
                          ...node.config.parameters,
                          [p.key]: value,
                        },
                      })
                    }
                  />
                ))}
            </details>
          ) : null}
          <details className={styles.details}>
            <summary>Effective prompt</summary>
            <p className={styles.effectivePrompt}>
              {effectivePrompt(graph, node.id)
                ? renderStudioProviderPrompt(
                    node.config.capabilityId || "",
                    effectivePrompt(graph, node.id),
                  )
                : "Add a prompt before running."}
            </p>
          </details>
        </>
      ) : null}
      {node.type === "asset" ? (
        <>
          <label className={styles.field}>
            Saved reference
            <select
              className={styles.select}
              value={node.config.assetId || ""}
              disabled={disabled}
              onChange={(e) => {
                const asset = assets.find((a) => a.id === e.target.value);
                config({
                  assetId: asset?.id,
                  assetMediaType: asset?.mediaType,
                  assetVersion: asset?.contentSha256,
                });
              }}
            >
              <option value="">Choose an asset</option>
              {node.config.assetId && !selectedAsset ? (
                <option value={node.config.assetId}>
                  Selected asset unavailable
                </option>
              ) : null}
              {assets.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.filename}
                  {a.demo ? " · demo" : ""}
                </option>
              ))}
            </select>
          </label>
          <input
            ref={upload}
            className={styles.hiddenInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void onUpload(file);
            }}
            tabIndex={-1}
          />
          <button
            className={styles.button}
            type="button"
            disabled={disabled || busy}
            onClick={() => upload.current?.click()}
          >
            <Upload size={16} aria-hidden="true" />
            {busy ? "Uploading…" : "Upload reference"}
          </button>
          <p className={styles.support}>
            Up to 3 MiB. Replacing this reference preserves the original file.
          </p>
          {selectedAsset ? (
            <AssetResult
              asset={selectedAsset}
              onReuse={onReuse}
              disabled={disabled}
            />
          ) : null}
        </>
      ) : null}
      {inputs.length ? (
        <details className={styles.details} open>
          <summary>Connections and reference order</summary>
          {references.map((edge, index) => (
            <div key={edge.id} className={styles.connectionRow}>
              <span>
                {graph.nodes.find((n) => n.id === edge.source)?.title ||
                  "Missing node"}{" "}
                · {edge.sourcePort} →{" "}
                {inputs.find((p) => p.id === edge.targetPort)?.label ||
                  edge.targetPort}
              </span>
              {edge.targetPort !== "prompt" ? (
                <p className={styles.support}>
                  {resolvedReferences[edge.id]?.length
                    ? resolvedReferences[edge.id]
                        .map(
                          (asset) => `${asset.filename} · ${asset.mediaType}`,
                        )
                        .join("; ")
                    : "No current media is selected. Resolve this source before running."}
                  {staleNodeIds.has(edge.source)
                    ? " This preview is stale; its source needs a fresh result."
                    : ""}
                </p>
              ) : null}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.iconButton}
                  disabled={disabled || index === 0}
                  aria-label="Move reference earlier"
                  onClick={() => {
                    const other = references[index - 1];
                    onGraph({
                      ...graph,
                      edges: graph.edges.map((e) =>
                        e.id === edge.id
                          ? { ...e, order: other.order }
                          : e.id === other.id
                            ? { ...e, order: edge.order }
                            : e,
                      ),
                    });
                  }}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  disabled={disabled || index === references.length - 1}
                  aria-label="Move reference later"
                  onClick={() => {
                    const other = references[index + 1];
                    onGraph({
                      ...graph,
                      edges: graph.edges.map((e) =>
                        e.id === edge.id
                          ? { ...e, order: other.order }
                          : e.id === other.id
                            ? { ...e, order: edge.order }
                            : e,
                      ),
                    });
                  }}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className={styles.button}
                  disabled={disabled}
                  onClick={() =>
                    onGraph({
                      ...graph,
                      edges: graph.edges.filter((e) => e.id !== edge.id),
                    })
                  }
                >
                  <Trash2 size={14} aria-hidden="true" />
                  Disconnect
                </button>
              </div>
            </div>
          ))}
          <label className={styles.field}>
            From output
            <select
              className={styles.select}
              value={connectFrom}
              disabled={disabled}
              onChange={(e) => setConnectFrom(e.target.value)}
            >
              <option value="">Choose a source</option>
              {sourceOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            To input
            <select
              className={styles.select}
              value={connectTo}
              disabled={disabled}
              onChange={(e) => setConnectTo(e.target.value)}
            >
              <option value="">Choose an input</option>
              {inputs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.type}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={styles.button}
            disabled={disabled || !connectFrom || !connectTo}
            onClick={connect}
          >
            <Plus size={14} aria-hidden="true" />
            Connect nodes
          </button>
        </details>
      ) : null}
      {issues.filter((i) => i.nodeId === node.id).length ? (
        <ul className={styles.issues}>
          {issues
            .filter((i) => i.nodeId === node.id)
            .map((i, index) => (
              <li key={index}>{i.message}</li>
            ))}
        </ul>
      ) : null}
      {node.type !== "note" ? (
        <div className={styles.actions}>
          <button
            className={styles.button}
            disabled={disabled || busy}
            type="button"
            onClick={() =>
              onRun({ mode: "node", nodeId: node.id, regenerate: false })
            }
          >
            Run node
          </button>
          <button
            className={styles.button}
            disabled={disabled || busy}
            type="button"
            onClick={() =>
              onRun({ mode: "to-here", nodeId: node.id, regenerate: false })
            }
          >
            Run to here
          </button>
          {generator ? (
            <button
              className={styles.button}
              disabled={disabled || busy}
              type="button"
              onClick={() =>
                onRun({ mode: "node", nodeId: node.id, regenerate: true })
              }
            >
              Regenerate
            </button>
          ) : null}
        </div>
      ) : null}
      {run ? (
        <p className={styles.support}>
          {statusLabel(run.status)}
          {run.reusedFrom ? " · reused successful work" : ""}
          {run.error ? `: ${run.error}` : ""}
        </p>
      ) : null}
      {outputs.length ? (
        <>
          <h3 className={styles.sectionHeading}>Saved results</h3>
          {stale ? (
            <p className={styles.notice} data-tone="warning">
              These saved results are retained for viewing. They no longer match
              this draft and its current inputs.
            </p>
          ) : null}
          {generator ? (
            <p className={styles.support}>
              Select one output for a single-media connection. The gallery can
              collect every output.
            </p>
          ) : null}
          {node.type === "output" ? (
            <ResultGallery
              assets={outputs}
              onReuse={onReuse}
              disabled={disabled}
            />
          ) : (
            outputs.map((asset) => (
              <div key={asset.id}>
                {generator && selectableOutputIds.includes(asset.id) ? (
                  <label className={styles.checkbox}>
                    <input
                      type="radio"
                      name={`output-${node.id}`}
                      checked={node.config.selectedOutputId === asset.id}
                      disabled={disabled}
                      onChange={() => config({ selectedOutputId: asset.id })}
                    />
                    Use this output downstream
                  </label>
                ) : generator ? (
                  <p className={styles.support}>
                    Historical result. Reuse it as a reference to keep this
                    exact version.
                  </p>
                ) : null}
                <AssetResult
                  asset={asset}
                  onReuse={onReuse}
                  disabled={disabled}
                />
              </div>
            ))
          )}
        </>
      ) : null}
    </>
  );
}
function ResultGallery({
  assets,
  onReuse,
  disabled,
}: {
  assets: StudioAsset[];
  onReuse: (asset: StudioAsset) => void;
  disabled: boolean;
}) {
  const [selectedId, setSelectedId] = useState(assets[0]?.id || "");
  const selected = assets.find((asset) => asset.id === selectedId) || assets[0];
  if (!selected) return null;
  return (
    <>
      <label className={styles.field}>
        Preview one of {assets.length} saved results
        <select
          className={styles.select}
          value={selected.id}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {assets.map((asset, index) => (
            <option key={asset.id} value={asset.id}>
              {index + 1}. {asset.filename} · {asset.mediaType}
            </option>
          ))}
        </select>
      </label>
      <AssetResult asset={selected} onReuse={onReuse} disabled={disabled} />
    </>
  );
}
function ParameterField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: StudioParameter;
  value: string | number | boolean;
  disabled: boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  if (field.type === "boolean")
    return (
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label}
      </label>
    );
  return (
    <label className={styles.field}>
      {field.label}
      {field.type === "select" ? (
        <select
          className={styles.select}
          value={String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options?.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      ) : (
        <input
          className={styles.input}
          type={field.type === "number" ? "number" : "text"}
          min={field.min}
          max={field.max}
          step={1}
          value={String(value)}
          disabled={disabled}
          onChange={(e) =>
            onChange(
              field.type === "number" ? Number(e.target.value) : e.target.value,
            )
          }
        />
      )}
    </label>
  );
}
export function AssetResult({
  asset,
  onReuse,
  disabled = false,
}: {
  asset: StudioAsset;
  onReuse: (asset: StudioAsset) => void;
  disabled?: boolean;
}) {
  return (
    <article className={styles.assetResult}>
      {asset.demo ? <span className={styles.demo}>Demo fixture</span> : null}
      {asset.mediaType.startsWith("image/") ||
      asset.mediaType.startsWith("video/") ? (
        <PrivateMediaPreview
          assetId={asset.id}
          kind={asset.mediaType.startsWith("image/") ? "image" : "video"}
          alt={asset.filename}
          compact
          className={styles.assetPreview}
        />
      ) : (
        <audio
          controls
          preload="metadata"
          src={studioAssetUrl(asset.id)}
          aria-label={asset.filename}
        />
      )}
      <p className={styles.support}>{asset.filename}</p>
      <dl className={styles.metadata}>
        <div>
          <dt>Media</dt>
          <dd>{asset.mediaType}</dd>
        </div>
        <div>
          <dt>File size</dt>
          <dd>{(asset.byteCount / 1024).toFixed(1)} KiB</dd>
        </div>
        {asset.width && asset.height ? (
          <div>
            <dt>Dimensions</dt>
            <dd>
              {asset.width} × {asset.height}
            </dd>
          </div>
        ) : null}
        {asset.durationSeconds ? (
          <div>
            <dt>Duration</dt>
            <dd>{asset.durationSeconds}s</dd>
          </div>
        ) : null}
      </dl>
      <div className={styles.actions}>
        <a className={styles.button} href={studioAssetUrl(asset.id, true)}>
          <Download size={14} aria-hidden="true" />
          Download
        </a>
        <button
          type="button"
          className={styles.button}
          disabled={disabled}
          onClick={() => onReuse(asset)}
        >
          <Plus size={14} aria-hidden="true" />
          Reuse reference
        </button>
      </div>
      <details className={styles.details}>
        <summary>Provenance</summary>
        <AssetProvenance asset={asset} />
      </details>
    </article>
  );
}

function AssetProvenance({ asset }: { asset: StudioAsset }) {
  const metadata = asset.metadata || {};
  const text = (key: string) =>
    typeof metadata[key] === "string" ? (metadata[key] as string) : undefined;
  const prompt = text("providerPrompt") || text("effectivePrompt");
  const settings =
    metadata.parameters &&
    typeof metadata.parameters === "object" &&
    !Array.isArray(metadata.parameters)
      ? Object.entries(metadata.parameters).filter(([, value]) =>
          ["string", "number", "boolean"].includes(typeof value),
        )
      : [];
  const inputs = Array.isArray(metadata.inputs)
    ? metadata.inputs.filter(
        (input): input is Record<string, unknown> =>
          Boolean(input) && typeof input === "object" && !Array.isArray(input),
      )
    : undefined;
  return (
    <>
      <p className={styles.support}>
        {asset.demo
          ? "Fixed demonstration media"
          : asset.origin === "studio"
            ? "Generated in Visual Studio"
            : "Saved application reference"}
        {asset.createdAt
          ? ` · ${new Date(asset.createdAt).toLocaleString()}`
          : ""}
      </p>
      <dl className={styles.metadata}>
        {[
          ["Provider", text("provider")],
          ["Model", text("model")],
          ["Operation", text("capabilityId")],
        ].map(([label, value]) =>
          value ? (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ) : null,
        )}
      </dl>
      {asset.origin === "studio" ? (
        <>
          <h4 className={styles.sectionHeading}>Submitted prompt</h4>
          <p className={styles.effectivePrompt}>
            {prompt || "The prompt was not recorded for this older result."}
          </p>
        </>
      ) : null}
      {settings.length ? (
        <>
          <h4 className={styles.sectionHeading}>Generation settings</h4>
          <dl className={styles.metadata}>
            {settings.map(([key, value]) => (
              <div key={key}>
                <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
      {inputs ? (
        <>
          <h4 className={styles.sectionHeading}>Source references</h4>
          {inputs.length ? (
            <ol>
              {inputs.map((input, index) => (
                <li
                  key={`${String(input.assetId)}:${index}`}
                  className={styles.support}
                >
                  {typeof input.role === "string" ? input.role : "Reference"} ·{" "}
                  {typeof input.mediaType === "string"
                    ? input.mediaType
                    : "Saved media"}
                  {typeof input.assetId === "string" ? (
                    <>
                      <br />
                      <a
                        href={studioAssetUrl(input.assetId)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open source {index + 1}
                      </a>
                      <p className={styles.code}>{input.assetId}</p>
                    </>
                  ) : null}
                  {typeof input.contentSha256 === "string" ? (
                    <p className={styles.code}>
                      SHA-256: {input.contentSha256}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.support}>No reference media was used.</p>
          )}
        </>
      ) : asset.origin === "studio" ? (
        <p className={styles.support}>
          Reference lineage was not recorded for this older result.
        </p>
      ) : null}
      <details className={styles.details}>
        <summary>Source run and file identifiers</summary>
        <p className={styles.code}>Asset: {asset.id}</p>
        <p className={styles.code}>SHA-256: {asset.contentSha256}</p>
        {[
          ["Flow", text("studioFlowId")],
          ["Run", text("studioRunId")],
          ["Node", text("studioNodeId")],
          ["Attempt", text("studioAttemptId")],
          ["Provider request", text("providerRequestId")],
        ].map(([label, value]) =>
          value ? (
            <p className={styles.code} key={label}>
              {label}: {value}
            </p>
          ) : null,
        )}
      </details>
    </>
  );
}

/** Keep historical downloads accessible even after their node is removed from the draft. */
export function SavedRunResults({
  assets,
  onReuse,
  disabled,
}: {
  assets: StudioAsset[];
  onReuse: (asset: StudioAsset) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!assets.length) return null;
  return (
    <details
      className={styles.details}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Preview and download results</summary>
      {open
        ? assets.map((asset) => (
            <AssetResult
              key={asset.id}
              asset={asset}
              onReuse={onReuse}
              disabled={disabled}
            />
          ))
        : null}
    </details>
  );
}
