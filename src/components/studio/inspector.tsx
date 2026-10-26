"use client";
import { useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Image as ImageIcon,
  Link2,
  Play,
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
import styles from "./inspector.module.css";

const commonParameterKeys = ["aspectRatio", "resolution", "imageSize", "outputCount", "durationSeconds"];

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
  const [imageDirectionOpen, setImageDirectionOpen] = useState(Boolean(node?.config.instruction));
  if (!node)
    return (
      <div className={styles.empty}>
        <h2 className={styles.heading}>Make it yours</h2>
        <p className={styles.support}>
          Select a step to edit its content, choose a model or explore its results.
        </p>
      </div>
    );
  const capability = capabilities.find(
    (c) => c.id === node.config.capabilityId,
  );
  const generator = node.type === "image" || node.type === "video";
  const promptConnection = graph.edges.find(
    (edge) => edge.target === node.id && edge.targetPort === "prompt",
  );
  const promptSource = graph.nodes.find((source) => source.id === promptConnection?.source);
  const connectedPrompt = Boolean(promptConnection);
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
  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);
  const promptField = (
    <label className={styles.field}>
      {node.type === "note" ? "Note" : connectedPrompt ? "Fallback prompt" : "Describe your idea"}
      <textarea
        className={styles.textarea}
        value={node.config.prompt || ""}
        rows={node.type === "note" ? 6 : 5}
        maxLength={8000}
        disabled={disabled}
        onChange={(event) => config({ prompt: event.target.value })}
        placeholder={node.type === "note" ? "Keep a note for this flow…" : "Describe the subject, setting and feeling you want…"}
      />
      {connectedPrompt ? <small>Used only if you disconnect the prompt step.</small> : null}
    </label>
  );
  const instructionField = (
    <label className={styles.field}>
      {node.type === "video" ? "Motion and direction" : "Additional direction"}
      <textarea
        className={styles.textarea}
        value={node.config.instruction || ""}
        rows={3}
        maxLength={4000}
        disabled={disabled}
        placeholder={node.type === "video" ? "Slow camera push, gentle movement, keep the subject in focus…" : "Optional: add lighting, composition or style details…"}
        onChange={(event) => config({ instruction: event.target.value })}
      />
      <small>Added to your prompt for this step.</small>
    </label>
  );
  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <div>
          {node.title.trim().toLowerCase() !== nodeLabels[node.type].toLowerCase() ? (
            <p className={styles.eyebrow}>{nodeLabels[node.type]}</p>
          ) : null}
          <h2 className={styles.heading}>{node.title}</h2>
        </div>
        {capability?.demo ? <span className={styles.demo}>Demo</span> : null}
      </header>
      {!node.enabled ? <p className={styles.notice}>This step is excluded from flow runs. Enable it in Step settings.</p> : null}

      {node.type === "prompt" || node.type === "note" ? promptField : null}
      {generator ? (
        <>
          {connectedPrompt ? (
            <div className={styles.promptSource}>
              <p><Link2 size={15} aria-hidden="true" /><span>Prompt from <strong>{promptSource?.title || "a missing step"}</strong></span></p>
              <p className={styles.promptExcerpt}>{promptSource?.config.prompt || "Add your idea to the connected prompt step."}</p>
            </div>
          ) : promptField}
          {node.type === "image" ? (
            <details
              className={`${styles.details} ${styles.optionalDirection}`}
              open={imageDirectionOpen}
              onToggle={(event) => setImageDirectionOpen(event.currentTarget.open)}
            >
              <summary>Add direction (optional)</summary>
              {instructionField}
            </details>
          ) : instructionField}
          <label className={styles.field}>
            Model
            <select
              className={styles.select}
              value={node.config.capabilityId || ""}
              disabled={disabled}
              onChange={(event) => {
                const next = capabilities.find((value) => value.id === event.target.value);
                if (!next) return;
                const switched = switchNodeCapability(node, next);
                onNode(switched.node);
                onNotice(
                  switched.changes.length
                    ? readableModelChanges(switched.changes, [...(capability?.parameters || []), ...next.parameters]).join(" ")
                    : "Model changed. Check that its reference connections remain compatible.",
                  "model-change",
                );
              }}
            >
              <option value="">Choose a model</option>
              {capabilities.filter((value) => value.mediaKind === node.type).map((value) => (
                <option key={value.id} value={value.id}>
                  {value.label}{value.demo ? " · Demo" : ""}{!value.available ? " · needs setup" : ""}
                </option>
              ))}
            </select>
          </label>
          {capability?.demo ? <p className={styles.support}>Demo uses fixed sample media. It does not generate new images or videos.</p> : null}
          {capability && !capability.available ? (
            <p className={styles.error}>{capability.unavailableReason} <a href="/app/settings">Open model settings</a></p>
          ) : null}
          <div className={styles.parameterGrid}>
            {capability?.parameters.filter((field) => commonParameterKeys.includes(field.key)).map((field) => (
              <ParameterField
                key={field.key}
                field={field}
                value={node.config.parameters[field.key] ?? field.default}
                disabled={disabled}
                onChange={(value) => config({ parameters: { ...node.config.parameters, [field.key]: value } })}
              />
            ))}
          </div>
        </>
      ) : null}

      {node.type === "asset" ? (
        <>
          {selectedAsset ? <AssetResult asset={selectedAsset} onReuse={onReuse} disabled={disabled} /> : (
            <div className={styles.empty}><ImageIcon size={28} aria-hidden="true" /><p>Add an image, video or audio reference.</p></div>
          )}
          <label className={styles.field}>
            Saved reference
            <select
              className={styles.select}
              value={node.config.assetId || ""}
              disabled={disabled}
              onChange={(event) => {
                const asset = assets.find((value) => value.id === event.target.value);
                config({ assetId: asset?.id, assetMediaType: asset?.mediaType, assetVersion: asset?.contentSha256 });
              }}
            >
              <option value="">Choose a saved file</option>
              {node.config.assetId && !selectedAsset ? <option value={node.config.assetId}>Selected file unavailable</option> : null}
              {assets.map((asset) => <option value={asset.id} key={asset.id}>{asset.filename}{asset.demo ? " · Demo" : ""}</option>)}
            </select>
          </label>
          <input
            ref={upload}
            className={styles.hiddenInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void onUpload(file);
            }}
            tabIndex={-1}
          />
          <button className={styles.button} type="button" disabled={disabled || busy} onClick={() => upload.current?.click()}>
            <Upload size={16} aria-hidden="true" />{busy ? "Uploading…" : "Upload a file"}
          </button>
          <p className={styles.support}>Up to 3 MiB. Your original file is preserved when you replace a reference.</p>
        </>
      ) : null}

      {nodeIssues.length ? (
        <ul className={styles.issues} aria-label="This step needs attention">{nodeIssues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>
      ) : null}
      {node.type !== "note" ? (
        <div className={styles.runActions}>
          <button
            className={styles.primary}
            disabled={disabled || busy}
            type="button"
            onClick={() => onRun({ mode: "to-here", nodeId: node.id, regenerate: false })}
          >
            <Play size={15} aria-hidden="true" />Review & run this step
          </button>
          <p className={styles.support}>See the cost first. Missing earlier steps are included.</p>
        </div>
      ) : null}
      {run ? <p className={run.error ? styles.error : styles.runStatus} role="status">{statusLabel(run.status)}{run.reusedFrom ? " · reused a saved result" : ""}{run.error ? `: ${run.error}` : ""}</p> : null}

      {outputs.length ? (
        <section className={styles.results} aria-label="Saved results">
          <h3 className={styles.sectionHeading}>Results <span>{outputs.length}</span></h3>
          {stale ? <p className={styles.notice}>Saved results no longer match this draft or its inputs. You can still view and reuse them.</p> : null}
          <StudioResultsGallery
            key={node.id}
            assets={outputs}
            onReuse={onReuse}
            disabled={disabled}
            selection={generator ? {
              nodeId: node.id,
              selectedOutputId: node.config.selectedOutputId,
              selectableOutputIds,
              onSelect: (assetId) => config({ selectedOutputId: assetId }),
            } : undefined}
          />
        </section>
      ) : node.type === "output" ? (
        <div className={styles.empty}><ImageIcon size={28} aria-hidden="true" /><p>Your finished images and videos will appear here.</p><p className={styles.support}>Connect a generation step, then run your flow.</p></div>
      ) : null}

      {generator ? (
        <details className={styles.details}>
          <summary>Advanced settings</summary>
          <div className={styles.detailsBody}>
            {capability?.parameters.filter((field) => !commonParameterKeys.includes(field.key)).map((field) => (
              <ParameterField
                key={field.key}
                field={field}
                value={node.config.parameters[field.key] ?? field.default}
                disabled={disabled}
                onChange={(value) => config({ parameters: { ...node.config.parameters, [field.key]: value } })}
              />
            ))}
            {connectedPrompt ? promptField : null}
            {capability ? <p className={styles.support}>{capability.model} · {capability.pricing.note}</p> : null}
            <details className={styles.details}>
              <summary>Full submitted prompt</summary>
              <p className={styles.effectivePrompt}>{effectivePrompt(graph, node.id) ? renderStudioProviderPrompt(node.config.capabilityId || "", effectivePrompt(graph, node.id)) : "Add a prompt before running."}</p>
            </details>
          </div>
        </details>
      ) : null}

      {inputs.length ? (
        <details className={styles.details}>
          <summary>Connections <span className={styles.summaryCount}>{references.length}</span></summary>
          <div className={styles.detailsBody}>
            <p className={styles.support}>Choose where this step gets its prompt and references. Reference order is preserved.</p>
            {references.map((edge, index) => (
              <div key={edge.id} className={styles.connectionRow}>
                <p className={styles.connectionTitle}>{graph.nodes.find((value) => value.id === edge.source)?.title || "Missing step"}<ArrowRight size={14} aria-hidden="true" />{inputs.find((port) => port.id === edge.targetPort)?.label || edge.targetPort}</p>
                {edge.targetPort !== "prompt" ? (
                  <p className={styles.support}>
                    {resolvedReferences[edge.id]?.length ? resolvedReferences[edge.id].map((asset) => asset.filename).join("; ") : "No current media is selected. Choose a result in the source step before running."}
                    {staleNodeIds.has(edge.source) ? " This source has changed and needs a fresh result." : ""}
                  </p>
                ) : null}
                <div className={styles.actions}>
                  <button type="button" className={styles.iconButton} disabled={disabled || index === 0} aria-label="Move reference earlier" onClick={() => {
                    const other = references[index - 1];
                    onGraph({ ...graph, edges: graph.edges.map((value) => value.id === edge.id ? { ...value, order: other.order } : value.id === other.id ? { ...value, order: edge.order } : value) });
                  }}><ArrowUp size={15} aria-hidden="true" /></button>
                  <button type="button" className={styles.iconButton} disabled={disabled || index === references.length - 1} aria-label="Move reference later" onClick={() => {
                    const other = references[index + 1];
                    onGraph({ ...graph, edges: graph.edges.map((value) => value.id === edge.id ? { ...value, order: other.order } : value.id === other.id ? { ...value, order: edge.order } : value) });
                  }}><ArrowDown size={15} aria-hidden="true" /></button>
                  <button type="button" className={styles.quietButton} disabled={disabled} onClick={() => onGraph({ ...graph, edges: graph.edges.filter((value) => value.id !== edge.id) })}><Trash2 size={15} aria-hidden="true" />Disconnect</button>
                </div>
              </div>
            ))}
            <label className={styles.field}>From step<select className={styles.select} value={connectFrom} disabled={disabled} onChange={(event) => setConnectFrom(event.target.value)}><option value="">Choose an output</option>{sourceOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
            <label className={styles.field}>To input<select className={styles.select} value={connectTo} disabled={disabled} onChange={(event) => setConnectTo(event.target.value)}><option value="">Choose an input</option>{inputs.map((port) => <option key={port.id} value={port.id}>{port.label} · {port.type}</option>)}</select></label>
            <button type="button" className={styles.button} disabled={disabled || !connectFrom || !connectTo} onClick={connect}><Plus size={15} aria-hidden="true" />Add connection</button>
          </div>
        </details>
      ) : null}
      <details className={styles.details}>
        <summary>Step settings</summary>
        <div className={styles.detailsBody}>
          <label className={styles.field}>Step name<input className={styles.input} value={node.title} maxLength={160} disabled={disabled} onChange={(event) => onNode({ ...node, title: event.target.value })} /></label>
          <label className={styles.checkbox}><input type="checkbox" checked={node.enabled} disabled={disabled} onChange={(event) => onNode({ ...node, enabled: event.target.checked })} />Include this step in flow runs</label>
        </div>
      </details>
      {node.type !== "note" ? (
        <details className={styles.details}>
          <summary>More run options</summary>
          <div className={styles.detailsBody}>
            <p className={styles.support}>Each option opens a cost review before work begins.</p>
            <div className={styles.runOption}>
              <button className={styles.button} disabled={disabled || busy} type="button" onClick={() => onRun({ mode: "node", nodeId: node.id, regenerate: false })}>Run step only</button>
              <p className={styles.support}>Use the current inputs without running earlier steps.</p>
            </div>
            <div className={styles.runOption}>
              <button className={styles.button} disabled={disabled || busy} type="button" onClick={() => onRun({ mode: "to-here", nodeId: node.id, regenerate: false })}>Run to here</button>
              <p className={styles.support}>Include any earlier steps needed for this result.</p>
            </div>
            {generator ? <div className={styles.runOption}><button className={styles.button} disabled={disabled || busy} type="button" onClick={() => onRun({ mode: "node", nodeId: node.id, regenerate: true })}>Regenerate</button><p className={styles.support}>Create a new result. Previous results stay saved.</p></div> : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

type OutputSelection = {
  nodeId: string;
  selectedOutputId?: string;
  selectableOutputIds: string[];
  onSelect: (assetId: string) => void;
};

function resultKind(asset: StudioAsset) {
  return asset.mediaType.startsWith("image/") ? "Image" : asset.mediaType.startsWith("video/") ? "Video" : "Audio";
}

function resultLabels(assets: StudioAsset[]) {
  const counts = new Map<string, number>();
  return assets.map((asset) => {
    const kind = resultKind(asset);
    const count = (counts.get(kind) || 0) + 1;
    counts.set(kind, count);
    return `${kind} ${count}`;
  });
}

function assetSummary(asset: StudioAsset) {
  return [
    asset.width && asset.height ? `${asset.width} × ${asset.height}` : undefined,
    asset.durationSeconds ? `${Number(asset.durationSeconds.toFixed(1))} sec` : undefined,
  ].filter(Boolean).join(" · ");
}

/** Preview navigation is local; only the explicit selection control changes downstream media. */
export function StudioResultsGallery({
  assets,
  onReuse,
  disabled,
  selection,
}: {
  assets: StudioAsset[];
  onReuse: (asset: StudioAsset) => void;
  disabled: boolean;
  selection?: OutputSelection;
}) {
  const [selectedId, setSelectedId] = useState(selection?.selectedOutputId || "");
  const selectedIndex = Math.max(0, assets.findIndex((asset) => asset.id === selectedId));
  const selected = assets[selectedIndex];
  const labels = resultLabels(assets);
  if (!selected) return <p className={styles.support}>Run a flow to see its saved results here.</p>;
  const canSelect = selection?.selectableOutputIds.includes(selected.id);
  const isSelected = selection?.selectedOutputId === selected.id;
  const downstreamIndex = assets.findIndex((asset) => asset.id === selection?.selectedOutputId);
  return (
    <div className={styles.gallery}>
      {assets.length > 1 ? (
        <div className={styles.galleryNavigation}>
          <label className={styles.previewChoice}>
            <span className={styles.srOnly}>Preview a saved result</span>
            <select className={styles.select} value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
              {assets.map((asset, index) => <option key={asset.id} value={asset.id}>{labels[index]}{assetSummary(asset) ? ` · ${assetSummary(asset)}` : ""}</option>)}
            </select>
          </label>
          <button className={styles.iconButton} type="button" aria-label="Preview previous result" disabled={selectedIndex === 0} onClick={() => setSelectedId(assets[selectedIndex - 1].id)}><ChevronLeft size={17} aria-hidden="true" /></button>
          <button className={styles.iconButton} type="button" aria-label="Preview next result" disabled={selectedIndex === assets.length - 1} onClick={() => setSelectedId(assets[selectedIndex + 1].id)}><ChevronRight size={17} aria-hidden="true" /></button>
        </div>
      ) : null}
      <AssetResult key={selected.id} asset={selected} label={labels[selectedIndex]} onReuse={onReuse} disabled={disabled} />
      {selection ? canSelect ? (
        <label className={styles.outputSelection} data-selected={isSelected}>
          <input type="radio" name={`output-${selection.nodeId}`} checked={isSelected} disabled={disabled} onChange={() => selection.onSelect(selected.id)} />
          <span>{isSelected ? "Used in the next step" : "Use this result in the next step"}<small>Previewing another result keeps this choice unchanged.</small></span>
          {isSelected ? <Check size={16} aria-hidden="true" /> : null}
        </label>
      ) : <p className={styles.support}>This is an earlier result. Use “Add as reference” to work with this exact file.</p> : null}
      {selection && downstreamIndex >= 0 && !isSelected ? (
        <p className={styles.support}>Next step uses {labels[downstreamIndex]}.</p>
      ) : null}
    </div>
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
  label,
}: {
  asset: StudioAsset;
  onReuse: (asset: StudioAsset) => void;
  disabled?: boolean;
  label?: string;
}) {
  const title = label || (asset.origin === "studio" ? `${resultKind(asset)} 1` : asset.filename);
  return (
    <article className={styles.assetResult} aria-label={title}>
      <div className={styles.assetHeading}>
        <div><h4>{title}</h4>{assetSummary(asset) ? <p className={styles.support}>{assetSummary(asset)}</p> : null}</div>
        {asset.demo ? <span className={styles.demo}>Demo</span> : null}
      </div>
      {asset.mediaType.startsWith("image/") || asset.mediaType.startsWith("video/") ? (
        <PrivateMediaPreview
          assetId={asset.id}
          kind={asset.mediaType.startsWith("image/") ? "image" : "video"}
          alt={title}
          compact
          className={styles.assetPreview}
          mediaClassName={styles.previewMedia}
        />
      ) : <audio controls preload="metadata" src={studioAssetUrl(asset.id)} aria-label={title} className={styles.audio} />}
      <div className={styles.assetActions}>
        <a className={styles.button} href={studioAssetUrl(asset.id, true)}><Download size={15} aria-hidden="true" />Download</a>
        <button type="button" className={styles.quietButton} disabled={disabled} onClick={() => onReuse(asset)}><Plus size={15} aria-hidden="true" />Add as reference</button>
      </div>
      <details className={styles.details}>
        <summary>File details</summary>
        <div className={styles.detailsBody}>
          <dl className={styles.metadata}>
            <div><dt>Filename</dt><dd>{asset.filename}</dd></div>
            <div><dt>Format</dt><dd>{asset.mediaType}</dd></div>
            <div><dt>File size</dt><dd>{(asset.byteCount / 1024).toFixed(1)} KiB</dd></div>
            {asset.width && asset.height ? <div><dt>Dimensions</dt><dd>{asset.width} × {asset.height}</dd></div> : null}
            {asset.durationSeconds ? <div><dt>Duration</dt><dd>{asset.durationSeconds}s</dd></div> : null}
          </dl>
          <AssetProvenance asset={asset} />
        </div>
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
      {open ? <div className={styles.detailsBody}><StudioResultsGallery assets={assets} onReuse={onReuse} disabled={disabled} /></div> : null}
    </details>
  );
}
