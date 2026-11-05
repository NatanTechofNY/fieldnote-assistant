import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { LoaderCircle, TriangleAlert, Unlink } from "lucide-react";
import { api } from "../../api";
import { ErrorState, Loading } from "../../components/ui";
import { useConfirm } from "../../lib/confirm";

/**
 * Both directions of the Alexa integration: Alexa+ calling Fieldnote's Household
 * tools (linking, which this page can revoke) and Fieldnote operating the
 * owner's Echo and smart home. Neither is a form: linking happens in the Alexa
 * app and control is configured on the server, so this page only reports state.
 */
export function AlexaSettings({ notify }: { notify: (message: string) => void }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["alexa"], queryFn: api.alexa });
  const unlink = useMutation({
    mutationFn: api.unlinkAlexa,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["alexa"] });
      notify("Alexa unlinked; its access is revoked");
    },
    onError: (mutationError: Error) => notify(mutationError.message),
  });
  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorState error={error} />;
  const { linking, control } = data;
  return <div className="settings-split">
    <div>
      <div className="card-title"><h3>Alexa+ → Fieldnote</h3></div>
      <p className="integration-copy">
        Alexa+ can read and add to the <strong>{linking.area}</strong> area only: its agenda, tasks and reminders.
        Nothing in your other areas, no memories, and no messages are reachable from an Echo.
      </p>
      <div className="integration-status">
        <span className={`dot ${linking.linkedSince ? "ok" : ""}`}/>
        {!linking.configured
          ? "Not set up. Add the Alexa OAuth client to the server environment."
          : linking.linkedSince
            ? `Linked since ${format(new Date(linking.linkedSince), "MMM d, yyyy")}`
            : "Set up, not linked yet. Link it from the Alexa app."}
      </div>
      {linking.configured && <small className="field-hint">MCP endpoint: <code>{linking.resource}</code></small>}
      {linking.linkedSince && <div className="actions">
        <button
          className="button danger"
          disabled={unlink.isPending}
          onClick={() => void confirm({ message: "Unlink Alexa? It will lose access immediately.", confirmLabel: "Unlink" })
            .then(ok => { if (ok) unlink.mutate(); })}
        >
          {unlink.isPending ? <LoaderCircle className="spin" size={14}/> : <Unlink size={14}/>}Unlink Alexa
        </button>
      </div>}
    </div>
    <div>
      <div className="card-title"><h3>Fieldnote → Alexa</h3></div>
      <p className="integration-copy">
        Lets the assistant switch lights and plugs, run your routines, and speak on an Echo, when you ask it to. It never
        operates locks, doors, garages, cameras or alarms, and it only does so on your own line.
      </p>
      <div className="integration-status">
        <span className={`dot ${control.configured && control.valid ? "ok" : ""}`}/>
        {!control.configured
          ? "Not set up. Install alexa-mcp and set ALEXA_REFRESH_TOKEN on the server."
          : control.valid
            ? `Connected${control.deviceCount !== undefined ? ` · ${control.deviceCount} devices` : ""}`
            : "Configured, but Amazon is not accepting the sign-in. Run alexa-mcp auth again."}
      </div>
      {control.error && <div className="inline-error"><TriangleAlert size={14}/><span>{control.error}</span></div>}
    </div>
  </div>;
}
