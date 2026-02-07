# 004 — Search / Filter in Sidebar ✅

**Priority**: High
**Effort**: Small
**Category**: UI/UX
**Status**: Completed

## Description

Added a real-time search/filter input at the top of the sidebar. Typing instantly filters both folders and assets by name (case-insensitive).

## Changes

### HTML (`frontend/index.html`)
- Added `<input id="search-filter">` below the path bar in the sidebar header

### CSS (`frontend/css/styles.css`)
- Added `.search-input` style — consistent with existing inputs, focus border highlight, placeholder color

### JavaScript (`frontend/js/file_browser.js`)
- Added `_currentFolders` and `_currentAssets` data caches (populated on each `browse()` call)
- Added `_filterText` state
- Added `setFilterInput(input)` — binds the input's `input` event to trigger re-render
- Added `_renderFiltered()` — applies filter to cached data and calls `_render()`
- `browse()` now clears the filter text and input value on navigation
- Empty state shows "No results matching filter" when filter is active

### JavaScript (`frontend/js/app.js`)
- Added `_initSearchFilter()` — passes the DOM input to `FileBrowser.setFilterInput()`

## Technical Notes
- Filtering is client-side against cached browse results — no additional API calls
- Filter clears automatically when navigating to a new directory
- Case-insensitive matching via `toLowerCase().includes()`
- Both folder names and asset names are matched
