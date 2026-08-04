import { Children, cloneElement, isValidElement, type ReactNode, useId } from "react";

/**
 * Wires the label to its control with a generated id. The single child is
 * cloned so callers keep writing plain `<input/>` without repeating the id.
 * A hint belongs in the prop rather than beside the control, because a second
 * child leaves nothing for the cloner to identify and the label goes unwired.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const only = Children.count(children) === 1 ? Children.only(children) : null;
  const control = isValidElement<{ id?: string }>(only) && !only.props.id
    ? cloneElement(only, { id })
    : children;
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    {control}
    {hint ? <small className="field-hint">{hint}</small> : null}
  </div>;
}
