# HAPI frontend improvements

Keep HAPI's native session backend and develop the web interface directly. The
T3, CloudCLI, and OpenCode experiments inform interaction design; their protocol
adapters are not part of this implementation.

## First increment: quick session switching

Open the switcher with Ctrl/Cmd+K from the sessions area, or use **Switch** in
the session-list toolbar. Search existing sessions by title, path, machine,
agent, or ID. Arrow keys select a result, Enter opens it, and Escape dismisses
the dialog. Empty searches show sessions by latest activity. Machine names and
paths distinguish conversations with similar titles.

This uses HAPI's existing metadata search and navigation. It searches sessions
already returned by the hub, not message contents or undiscovered native history.

## Next increments

These are candidates for subsequent work, not implemented features.

| Area | Interaction to borrow | Existing HAPI foundation | Intended result |
| --- | --- | --- | --- |
| Execution display | CloudCLI's grouped activity and agent details | Tool cards and Codex agent event projection | See which agent is working, its latest activity, and its result without expanding every tool call. |
| Conversation and changes | OpenCode's session/changes workflow | Existing file browser and Git diff routes | Reach changes from the relevant conversation and return without losing reading position. |
| Input controls | Compact, discoverable controls in the evaluated clients | Model/effort selectors, durable queue, steering | Clearly show the configuration and whether the next message will queue or steer. |
| Long conversations | Navigable conversation sections | Existing paginated message window | Find user turns and return to the latest reply without repeated scrolling. |

Implement each increment against existing HAPI data first. New backend fields
should represent a concrete missing capability. Verify live state changes and
mobile interactions as part of each increment; a rendered control alone does not
establish that its operation works.
