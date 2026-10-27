# Repository instructions

## Schema versions and full replay

Changing `CURRENT_SCHEMA_VERSION` invalidates users' cached state and forces a
full replay of the event log. This is a very expensive production operation.
**Keep the version unchanged unless a full replay is required for correctness.**

- Prefer backward-compatible defaults, lazy initialization, targeted cache
  migrations, or recomputation from facts already in cached state.
- Adding fields, slices, event types, screens, or features does not by itself
  require a version bump. Neither does changing a reducer if the affected
  historical events have not occurred in production.
- Do not bump "to be safe," for consistency, as routine deployment housekeeping,
  or to reset an emulator. Use environment-specific tools for emulator resets.
- Before any bump, document the exact existing production cache contents that
  would otherwise be incorrect, why the alternatives above are insufficient,
  and the expected full-replay cost. Check production evidence rather than
  assuming the affected cached state exists.
- If necessity has not been established, leave the version unchanged and
  investigate. Do not lower or revert a deployed version to undo an unnecessary
  bump: another version mismatch can force another replay.

Apply this rule to design documents and implementation plans as well as code.
Do not prescribe a schema bump automatically for new work.
