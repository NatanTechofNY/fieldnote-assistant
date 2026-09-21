import { type ReactNode, useState } from "react";
import { Check, Copy, Globe, TriangleAlert } from "lucide-react";
import { Field } from "../../components/ui";
import { useRedact } from "../../lib/demo-mode";
import { currentPublicOrigin } from "../../lib/public-origin";

const trimSlash = (value: string): string => value.trim().replace(/\/$/, "");

/**
 * The base-URL field each message provider shares, with the origin the app is
 * running at shown beside it. After a move — a new tunnel, a deploy — the saved
 * URL and the current one disagree, and this is where that shows up, with one
 * click to bring the field up to date before the provider is reconfigured.
 */
export function WebhookUrlField({ provider, value, savedValue, onChange, paths, hint }: {
  provider: string;
  value: string;
  /** What the provider was last configured with, so a move can be pointed out. */
  savedValue?: string;
  onChange: (next: string) => void;
  /** The endpoints under the base URL, listed so they can be checked against the provider's dashboard. */
  paths: { label: string; path: string }[];
  hint: ReactNode;
}) {
  const redact = useRedact();
  const origin = currentPublicOrigin();
  const base = trimSlash(value);
  const saved = savedValue ? trimSlash(savedValue) : "";
  const matchesOrigin = origin !== null && base === origin;
  const moved = origin !== null && saved !== "" && saved !== origin;
  return <div className="webhook-field">
    <Field label="Public HTTPS URL" hint={hint}>
      <input
        className="input"
        type={redact.inputType("url")}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={origin ?? "https://your-tunnel.ngrok-free.app"}
      />
    </Field>
    {origin && !matchesOrigin && <div className={`webhook-origin ${moved ? "moved" : ""}`}>
      {moved ? <TriangleAlert size={14} aria-hidden="true"/> : <Globe size={14} aria-hidden="true"/>}
      <span>
        {moved
          ? <>This app is now at <code>{redact.url(origin)}</code>, but {provider} was last configured with <code>{redact.url(saved)}</code>.</>
          : <>This app is running at <code>{redact.url(origin)}</code>.</>}
      </span>
      <button type="button" className="button ghost" onClick={() => onChange(origin)}>Use this URL</button>
    </div>}
    {matchesOrigin && <small className="field-hint webhook-match"><Check size={11} aria-hidden="true"/> Matches where this app is running.</small>}
    {base.startsWith("https://") && <ul className="webhook-endpoints" aria-label={`${provider} webhook endpoints`}>
      {paths.map(({ label, path }) => <WebhookEndpoint key={path} label={label} url={`${base}${path}`}/>)}
    </ul>}
  </div>;
}

function WebhookEndpoint({ label, url }: { label: string; url: string }) {
  const redact = useRedact();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText?.(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return <li>
    <span className="webhook-endpoint-label">{label}</span>
    <code title={redact.enabled ? undefined : url}>{redact.url(url)}</code>
    <button type="button" className="button icon ghost" aria-label={`Copy ${label} webhook URL`} onClick={() => void copy()}>
      {copied ? <Check size={12}/> : <Copy size={12}/>}
    </button>
  </li>;
}
