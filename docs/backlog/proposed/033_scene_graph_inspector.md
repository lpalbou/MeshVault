# 033 — Scene-graph inspector + per-node visibility

**Priority**: Medium
**Effort**: Medium
**Status**: Proposed
**Created**: 2026-07-06

## Summary

Show the model's node/mesh hierarchy as a tree in the UI with per-node visibility toggles
(and isolate/solo). Also expose it via the API (`get_scene_tree`, `set_node_visible`). Useful
for inspecting multi-part assets and for agents to isolate/query specific parts.

## Reason / evidence

- 2026 market research: scene-graph tree + per-node visibility is a common inspector feature.
- Complements `describe_scene` (029) with interactive control.

## Current code reality

- `getSceneInfo` lists meshes flat (no hierarchy, no visibility control).

## Scope

- Build a tree from the loaded object graph; UI panel with toggles + isolate; API commands
  to query the tree and set node visibility by name/id.

## Acceptance criteria

- Hiding/soloing a node updates the render and is reflected in state; the tree matches the
  model hierarchy.
