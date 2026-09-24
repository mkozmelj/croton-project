import type { PendingActionRow } from "../db/pending-actions.js";

// What the bot sends back: the text, then one Confirm/Cancel message per proposal.
export type Reply = {
  text: string;
  proposals: PendingActionRow[];
};
