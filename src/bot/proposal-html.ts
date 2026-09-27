import {
  addMarkerPayload,
  applyPlanPayload,
  setGoalPayload,
  updateProfilePayload,
} from "../agent/actions.js";
import { formatDuration } from "../agent/activity-format.js";
import type { PendingActionRow } from "../db/pending-actions.js";
import { describeSource, formatMarkerValue, type Marker } from "../training/markers.js";
import { bold, esc, sportEmoji } from "./html.js";
import { planHtml } from "./plan-html.js";

// What the athlete confirms, as Telegram HTML (ADR-017): rendered by code from the payload,
// like describeProposal() in agent/actions.ts, which stays the plain version for the model.

function markerLine(marker: Marker): string {
  const via = marker.notes ? ` (${esc(marker.notes)})` : "";
  return `${sportEmoji(marker.sport)} ${esc(marker.sport)}: <b>${esc(formatMarkerValue(marker.metric, marker.value))}</b> · ${describeSource(marker.source)} · ${marker.measuredOn}${via}`;
}

export function proposalHtml(row: Pick<PendingActionRow, "actionType" | "payload">): string {
  switch (row.actionType) {
    case "set_goal": {
      const { event, goal, replaceGoal } = setGoalPayload.parse(row.payload);
      const what = [event.sport, event.distance].filter(Boolean).join(", ");
      const where = event.location ? ` · ${esc(event.location)}` : "";
      const lines = [
        `🎯 <b>New ${goal.priority} goal for ${goal.season}</b>`,
        `${bold(event.name)} (${esc(what)})`,
        `📅 ${event.date}${where}`,
        `Goal: ${goal.goalType}${goal.target ? `, ${esc(goal.target)}` : ""}`,
      ];
      if (goal.notes) lines.push(`📝 ${esc(goal.notes)}`);
      if (replaceGoal) lines.push(`⚠️ Replaces the current A goal: ${esc(replaceGoal.name)}`);
      return lines.join("\n");
    }
    case "update_profile": {
      const p = updateProfilePayload.parse(row.payload);
      const lines = ["👤 <b>Profile update</b>"];
      if (p.name) lines.push(`• Name: ${esc(p.name)}`);
      if (p.background) {
        const b = p.background;
        if (b.years_by_sport.length > 0) {
          lines.push(
            `• Years training: ${esc(b.years_by_sport.map((y) => `${y.sport} ${y.years}`).join(", "))}`,
          );
        }
        if (b.typical_weekly_hours != null) {
          lines.push(`• Typical week: ${b.typical_weekly_hours} h`);
        }
        for (const r of b.recent_results) {
          const time = r.time_seconds ? `, ${formatDuration(r.time_seconds)}` : "";
          lines.push(`• Result ${r.date}: ${esc(r.event)}${time}`);
        }
        if (b.notes) lines.push(`• Notes: ${esc(b.notes)}`);
      }
      if (p.availability) lines.push(`• Availability: ${esc(p.availability)}`);
      if (p.injuryNotes) lines.push(`• Injuries: ${esc(p.injuryNotes)}`);
      if (p.raceMarkers.length > 0) {
        lines.push("", "<b>Adds</b>", ...p.raceMarkers.map(markerLine));
      }
      return lines.join("\n");
    }
    case "add_fitness_marker": {
      const { markers } = addMarkerPayload.parse(row.payload);
      const title = markers.length === 1 ? "New fitness marker" : "New fitness markers";
      return [`📈 <b>${title}</b>`, ...markers.map(markerLine)].join("\n");
    }
    case "apply_plan": {
      const { plan, reason } = applyPlanPayload.parse(row.payload);
      const title = reason ? `🔄 <b>Plan change:</b> ${esc(reason)}` : "📋 <b>Proposed plan</b>";
      return [title, "", planHtml(plan)].join("\n");
    }
    case "recap":
      return "📝 Weekly recap: waiting for your feedback.";
    case "onboarding":
      return "👋 Onboarding in progress.";
    case "activity_feedback":
      return "💬 Activity feedback: waiting for a note.";
  }
}
