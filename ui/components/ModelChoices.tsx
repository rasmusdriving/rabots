// The models as a row of choices, in "Add a bot" and in a bot's settings (step 3a). With both kinds
// in the list, two quiet groups, "Claude" and "ChatGPT", each a row of its own under a small
// heading; with one kind, one row as before. The whole is one group named "Model".
// For a bot that exists (`current`), the heading of the group it is not on says quietly, on the
// heading's own line, that choosing there starts a fresh session; in "Add a bot" both stay plain.
import type { Harness, ModelInfo } from "../../shared/protocol";
import { groupModels, groupNote } from "../lib/models";

interface Props {
  models: ModelInfo[];
  value: string;
  onPick(id: string): void;
  /** The id of the visible label of the field, when there is one; else the group is named "Model". */
  labelledBy?: string;
  /** The group the bot is on now; absent for a bot not made yet. */
  current?: Harness;
}

export function ModelChoices({ models, value, onPick, labelledBy, current }: Props) {
  const groups = groupModels(models);
  const name = labelledBy ? { "aria-labelledby": labelledBy } : { "aria-label": "Model" };
  const buttons = (list: ModelInfo[]) =>
    list.map((m) => (
      <button key={m.id} type="button" aria-pressed={m.id === value} onClick={() => onPick(m.id)}>
        {m.label}
      </button>
    ));

  if (groups.length <= 1)
    return (
      <div className="pb-seg app-seg-wrap" role="group" {...name}>
        {buttons(models)}
      </div>
    );

  return (
    <div className="pb-model-groups" role="group" {...name}>
      {groups.map((g) => {
        const note = groupNote(g.harness, current);
        return (
          <div className="pb-model-group" key={g.harness} data-harness={g.harness}>
            <span className="pb-model-group-title" aria-hidden="true">
              <span className="pb-group-name">{g.label}</span>
              {note && <span className="pb-group-note">{note}</span>}
            </span>
            <div className="pb-seg app-seg-wrap" role="group" aria-label={note ? `${g.label}, ${note}` : g.label}>
              {buttons(g.models)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
