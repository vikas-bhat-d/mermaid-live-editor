<script lang="ts">
  import type { State, ValidatedState } from '$/types';
  import { recordRenderTime, shouldRefreshView } from '$/util/autoSync';
  import { render as renderDiagram } from '$/util/mermaid';
  import { PanZoomState } from '$/util/panZoom';
  import { inputStateStore, stateStore, updateCodeStore } from '$/util/state';
  import uniqueID from 'lodash-es/uniqueId';
  import type { MermaidConfig } from 'mermaid';
  import { mode } from 'mode-watcher';
  import { onMount } from 'svelte';
  import { Svg2Roughjs } from 'svg2roughjs';

  let {
    panZoomState = new PanZoomState(),
    shouldShowGrid = true
  }: { panZoomState?: PanZoomState; shouldShowGrid?: boolean } = $props();
  let code = '';
  let config = '';
  let container: HTMLDivElement | undefined = $state();
  let rough: boolean;
  let view: HTMLDivElement | undefined = $state();
  let error = $state(false);
  let panZoom = true;
  let manualUpdate = true;

  // Set up panZoom state observer to update the store when pan/zoom changes
  const setupPanZoomObserver = () => {
    panZoomState.onPanZoomChange = (pan, zoom) => {
      updateCodeStore({ pan, zoom });
    };
  };

  const handlePanZoom = (state: State, graphDiv: SVGSVGElement) => {
    try {
      panZoomState.updateElement(graphDiv, state);
    } catch (error) {
      console.error('PanZoom error:', error);
    }
  };

  const handleStateChange = async (state: ValidatedState) => {
    const startTime = Date.now();
    if (state.error !== undefined) {
      error = true;
      return;
    }
    error = false;
    let diagramType: string | undefined;
    try {
      if (container) {
        manualUpdate = true;
        // Do not render if there is no change in Code/Config/PanZoom
        if (
          code === state.code &&
          config === state.mermaid &&
          rough === state.rough &&
          panZoom === state.panZoom
        ) {
          return;
        }

        if (!shouldRefreshView()) {
          return;
        }

        code = state.code;
        config = state.mermaid;
        rough = state.rough;
        panZoom = state.panZoom ?? true;

        const scroll = view?.parentElement?.scrollTop;
        delete container.dataset.processed;
        const viewID = uniqueID('graph-');
        const {
          svg,
          bindFunctions,
          diagramType: detectedDiagramType
        } = await renderDiagram(JSON.parse(state.mermaid) as MermaidConfig, code, viewID);
        diagramType = detectedDiagramType;
        if (svg.length > 0) {
          // eslint-disable-next-line svelte/no-dom-manipulating
          container.innerHTML = svg;
          let graphDiv = document.querySelector<SVGSVGElement>(`#${viewID}`);
          if (!graphDiv) {
            throw new Error('graph-div not found');
          }
          if (false && state.rough) {
            const svg2roughjs = new Svg2Roughjs('#container');
            svg2roughjs.svg = graphDiv;
            await svg2roughjs.sketch();
            graphDiv.remove();
            const sketch = document.querySelector<SVGSVGElement>('#container > svg');
            if (!sketch) {
              throw new Error('sketch not found');
            }
            const height = sketch.getAttribute('height');
            const width = sketch.getAttribute('width');
            sketch.setAttribute('id', 'graph-div');
            sketch.setAttribute('height', '100%');
            sketch.setAttribute('width', '100%');
            sketch.setAttribute('viewBox', `0 0 ${width} ${height}`);
            sketch.style.maxWidth = '100%';
            graphDiv = sketch;
          } else {
            graphDiv.setAttribute('height', '100%');
            graphDiv.style.maxWidth = '100%';
            if (bindFunctions) {
              bindFunctions(graphDiv);
            }
          }
          if (state.panZoom) {
            handlePanZoom(state, graphDiv);
          }
          // Inject wider transparent hit-area paths over edges for easier interaction
          injectEdgeHitAreas(graphDiv);
        }
        if (view?.parentElement && scroll) {
          view.parentElement.scrollTop = scroll;
        }
        error = false;
      } else if (manualUpdate) {
        manualUpdate = false;
      }
    } catch (error_) {
      console.error('view fail', error_);
      error = true;
    }
    const renderTime = Date.now() - startTime;
    saveStatistics({ code, diagramType, isRough: state.rough, renderTime });
    recordRenderTime(renderTime, () => {
      $inputStateStore.updateDiagram = true;
    });
  };

  function getMermaidNodeId(element: Element): string | null {
    const nodeEl = element.closest('.node');
    console.log(
      '[VisualEditor] getMermaidNodeId called. target:',
      element,
      'found closest .node:',
      nodeEl
    );
    if (!nodeEl) return null;
    let idAttr = nodeEl.id;
    console.log('[VisualEditor] found node idAttr:', idAttr);
    if (!idAttr || idAttr === 'null') return null;

    // Iteratively strip standard wrapper prefixes generated by Mermaid/Elk
    let prev;
    do {
      prev = idAttr;
      idAttr = idAttr.replace(/^graph-\d+-/, '');
      idAttr = idAttr.replace(/^(flowchart|state|class)-/, '');
    } while (idAttr !== prev);

    const code = $inputStateStore.code;

    // Helper to verify if an ID truly exists in the user's Mermaid code
    const idExists = (id: string) => {
      const escapedId = id.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      // Matches ID followed by a node shape [({ or an edge --> or the end of a line
      const regex = new RegExp(`(?:^|\\s)${escapedId}(?:\\s*[\\[\\(\\{>]|\\s*-->|\\s*---|$)`);
      return regex.test(code);
    };

    // Example idAttr: "Christmas-95" or "C". Let's check if it exists verbatim.
    if (idExists(idAttr)) {
      console.log('[VisualEditor] parsed exact node ID:', idAttr);
      return idAttr;
    }

    // If it doesn't exist, it likely has a trailing random number from Mermaid e.g. "Christmas-95"
    const stripped = idAttr.replace(/-\d+$/, '');
    if (idExists(stripped)) {
      console.log('[VisualEditor] parsed stripped node ID:', stripped);
      return stripped;
    }

    console.log('[VisualEditor] fallback parsed node ID:', stripped || idAttr);
    return stripped || idAttr;
  }

  // Strip Mermaid-internal prefixes/suffixes from a raw LS-/LE- class ID so it
  // matches the actual node ID written in the user's code.
  function stripMermaidId(rawId: string): string {
    let id = rawId;
    let prev;
    do {
      prev = id;
      id = id.replace(/^graph-\d+-/, '');
      id = id.replace(/^(flowchart|state|class)-/, '');
    } while (id !== prev);

    const src = $inputStateStore.code;
    const idExists = (testId: string) => {
      const esc = testId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      return new RegExp(`(?:^|\\s)${esc}(?:\\s*[\\[\\(\\{>]|\\s*-->|\\s*---|$)`).test(src);
    };

    if (idExists(id)) return id;
    const stripped = id.replace(/-\d+$/, '');
    return idExists(stripped) ? stripped : stripped || id;
  }

  function getNextNodeId(code: string): string {
    const matches = [...code.matchAll(/\bn(\d+)\b/g)];
    let max = 0;
    for (const match of matches) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
    return `n${max + 1}`;
  }

  // Track Space key so we don't interfere with pan-zoom when the user holds Space to pan
  let isSpaceDown = false;

  let isDragging = $state(false);
  let dragStartX = $state(0);
  let dragStartY = $state(0);
  let dragCurrentX = $state(0);
  let dragCurrentY = $state(0);
  let sourceNodeId = $state<string | null>(null);
  let dragTargetNode = $state<Element | null>(null);

  let editingNodeId = $state<string | null>(null);
  let editingLabelEl = $state<Element | null>(null);
  let editText = $state<string>('');
  let editX = $state(0);
  let editY = $state(0);
  let editW = $state(0);
  let editH = $state(0);
  let editFontSize = $state(16);

  let selectedNode = $state<Element | null>(null);
  let quickActionX = $state(0);
  let quickActionY = $state(0);
  let quickActionSize = $state(28);

  let hoveredEdgePath = $state<Element | null>(null);
  let hoveredEdgeSourceId = $state<string | null>(null);
  let hoveredEdgeTargetId = $state<string | null>(null);
  let hoveredEdgeIndex = $state<number>(-1);

  // Selected edge — persists on click; toolbar anchors to the click position
  let selectedEdgePath = $state<Element | null>(null);
  let selectedEdgeX = $state(0);
  let selectedEdgeY = $state(0);
  let selectedEdgeSourceId = $state<string | null>(null);
  let selectedEdgeTargetId = $state<string | null>(null);
  let selectedEdgeIndex = $state<number>(-1);

  let editingEdgeSource: string | null = null;
  let editingEdgeTarget: string | null = null;

  // Maps each transparent hit-area path → the actual visible edge path it overlays
  let edgeHitAreaMap = new WeakMap<Element, Element>();

  /** After an SVG render, inject wide transparent paths over every edge for easier hit-testing. */
  function injectEdgeHitAreas(svgEl: SVGSVGElement) {
    edgeHitAreaMap = new WeakMap();
    const edgePaths = svgEl.querySelectorAll<SVGPathElement>(
      '.flowchart-link, path[class*="edge-pattern"]'
    );
    console.log('[injectEdgeHitAreas] Found', edgePaths.length, 'edge paths');
    edgePaths.forEach((path, idx) => {
      // Skip if we already injected a hit area for this path
      if (path.nextElementSibling?.classList.contains('edge-hit-area')) {
        console.log('[injectEdgeHitAreas] Skipping path', idx, 'already has hit area');
        return;
      }
      const hitArea = path.cloneNode(false) as SVGPathElement;
      hitArea.removeAttribute('id');
      hitArea.removeAttribute('marker-end');
      hitArea.removeAttribute('marker-start');
      hitArea.removeAttribute('marker-mid');
      hitArea.classList.add('edge-hit-area');
      // hitArea.setAttribute('stroke', 'blue'); managed in css
      hitArea.setAttribute('fill', 'none');
      // hitArea.setAttribute('stroke-width', '50'); already managed in csss
      hitArea.setAttribute('pointer-events', 'stroke');
      path.parentNode?.insertBefore(hitArea, path.nextSibling);
      edgeHitAreaMap.set(hitArea, path);
      console.log('[injectEdgeHitAreas] Injected hit area for path', idx);
    });
    console.log('[injectEdgeHitAreas] Total hit areas injected:', edgePaths.length);
  }

  /** Return the real edge path for a given element (resolves hit-area → actual path). */
  function resolveEdgePath(el: Element): Element {
    return edgeHitAreaMap.get(el) ?? el;
  }

  $effect(() => {
    if (selectedNode && view) {
      let rafId: number;
      const updatePosition = () => {
        if (!selectedNode || !view) return;
        const rect = selectedNode.getBoundingClientRect();
        const viewRect = view.getBoundingClientRect();

        // Scale the button size relative to the node height (e.g. 40%), min 16px, max 48px
        quickActionSize = Math.max(16, Math.min(48, rect.height * 0.4));

        // Position at the bottom center of the node
        quickActionX = rect.left - viewRect.left + rect.width / 2 - quickActionSize / 2;
        quickActionY = rect.bottom - viewRect.top + 5;

        rafId = requestAnimationFrame(updatePosition);
      };
      rafId = requestAnimationFrame(updatePosition);
      return () => cancelAnimationFrame(rafId);
    }
  });

  function clearSelection() {
    if (selectedNode) {
      selectedNode.classList.remove('visual-selected');
      selectedNode = null;
    }
  }

  function clearEdgeSelection() {
    if (selectedEdgePath) {
      selectedEdgePath.classList.remove('edge-selected');
      selectedEdgePath = null;
      selectedEdgeSourceId = null;
      selectedEdgeTargetId = null;
      selectedEdgeIndex = -1;
    }
  }

  /** Extract source/target node IDs and edge index from an SVG path element. */
  function extractEdgeIds(pathEl: Element): {
    sourceId: string | null;
    targetId: string | null;
    index: number;
  } {
    let sourceId: string | null = null;
    let targetId: string | null = null;
    let index = -1;
    pathEl.classList.forEach((c) => {
      if (c.startsWith('LS-')) sourceId = stripMermaidId(c.substring(3));
      if (c.startsWith('LE-')) targetId = stripMermaidId(c.substring(3));
    });
    if (!sourceId || !targetId) {
      const dataId = pathEl.getAttribute('data-id') || pathEl.id || '';
      const dataMatch = dataId.replace(/^graph-\d+-/, '').match(/^L[_-](.+)[_-](\d+)$/);
      if (dataMatch) {
        const middle = dataMatch[1];
        index = parseInt(dataMatch[2], 10);
        const src = $inputStateStore.code;
        const idExists = (id: string) => {
          const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(`(?:^|\\s)${esc}(?:\\s*[\\[\\(\\{>]|\\s*-->|\\s*---|$)`).test(src);
        };
        const tokens = middle.split('_');
        for (let i = 1; i < tokens.length; i++) {
          const s = tokens.slice(0, i).join('_');
          const t = tokens.slice(i).join('_');
          if (idExists(s) && idExists(t)) {
            sourceId = s;
            targetId = t;
            break;
          }
        }
      }
    }
    return { sourceId, targetId, index };
  }

  function handleMouseDown(e: MouseEvent) {
    if (editingNodeId) return;
    if (isSpaceDown) return; // Space held = pan mode, don't interact with nodes
    const target = e.target as Element;
    console.log('[VisualEditor] MouseDown on target:', target);

    // Check if clicking the quick action button or edge action buttons
    if (target.closest('.quick-action-btn') || target.closest('.edge-action-btn')) {
      return; // Handled by their own click listeners
    }

    const nodeId = getMermaidNodeId(target);
    if (nodeId) {
      clearEdgeSelection();
      clearSelection();
      selectedNode = target.closest('.node');
      if (selectedNode) {
        selectedNode.classList.add('visual-selected');
      }

      console.log('[VisualEditor] Starting drag from node:', nodeId);
      e.stopPropagation(); // Prevent pan-zoom
      isDragging = true;
      sourceNodeId = nodeId;
      const rect = view?.getBoundingClientRect();
      if (rect) {
        dragStartX = e.clientX - rect.left;
        dragStartY = e.clientY - rect.top;
        dragCurrentX = dragStartX;
        dragCurrentY = dragStartY;
      }
    } else {
      // Check if clicking on an edge path (including wide hit areas) — select it
      const rawEdgeEl = target.closest(
        '.flowchart-link, path[class*="edge-pattern"], .edge-hit-area'
      );
      console.log(
        '[handleMouseDown] rawEdgeEl from closest:',
        rawEdgeEl?.tagName,
        rawEdgeEl?.className
      );
      if (rawEdgeEl && !target.closest('.edgeLabel, .node')) {
        const edgePath = resolveEdgePath(rawEdgeEl);
        console.log('[handleMouseDown] Resolved edge path:', edgePath?.tagName);
        clearSelection();
        clearEdgeSelection();

        selectedEdgePath = edgePath;
        selectedEdgePath.classList.add('edge-selected');

        const ids = extractEdgeIds(edgePath);
        selectedEdgeSourceId = ids.sourceId;
        selectedEdgeTargetId = ids.targetId;
        selectedEdgeIndex = ids.index;

        const viewRect = view?.getBoundingClientRect();
        if (viewRect) {
          selectedEdgeX = e.clientX - viewRect.left;
          selectedEdgeY = e.clientY - viewRect.top;
        }

        e.stopPropagation();
      } else {
        clearEdgeSelection();
        clearSelection();
      }
    }
  }

  function handleMouseMove(e: MouseEvent) {
    const target = e.target as Element;

    // Handle Edge Hover (glow only — toolbar appears on click via selectedEdgePath)
    if (!isDragging && !editingNodeId) {
      const rawEl = target.closest('.flowchart-link, path[class*="edge-pattern"], .edge-hit-area');
      console.log('[handleMouseMove] rawEl:', rawEl?.tagName, rawEl?.className);
      const pathEl = rawEl ? resolveEdgePath(rawEl) : null;
      console.log('[handleMouseMove] pathEl:', pathEl?.tagName);
      if (pathEl && !target.closest('.edgeLabel, .node, .quick-action-btn, .edge-action-btn')) {
        if (hoveredEdgePath !== pathEl) {
          // Remove glow from previous edge
          if (hoveredEdgePath) hoveredEdgePath.classList.remove('edge-hovered');
          hoveredEdgePath = pathEl;
          hoveredEdgePath.classList.add('edge-hovered');
          const ids = extractEdgeIds(pathEl);
          hoveredEdgeSourceId = ids.sourceId;
          hoveredEdgeTargetId = ids.targetId;
          hoveredEdgeIndex = ids.index;
          console.log(
            '[VisualEditor] Edge hover IDs:',
            hoveredEdgeSourceId,
            '->',
            hoveredEdgeTargetId
          );
        }
      } else if (!target.closest('.edge-action-btn')) {
        hoveredEdgePath?.classList.remove('edge-hovered');
        hoveredEdgePath = null;
        hoveredEdgeSourceId = null;
        hoveredEdgeTargetId = null;
        hoveredEdgeIndex = -1;
      }
    } else {
      hoveredEdgePath?.classList.remove('edge-hovered');
      hoveredEdgePath = null;
      hoveredEdgeSourceId = null;
      hoveredEdgeTargetId = null;
      hoveredEdgeIndex = -1;
    }

    if (isDragging) {
      e.stopPropagation(); // Prevent pan-zoom dragging
      const rect = view?.getBoundingClientRect();
      if (rect) {
        dragCurrentX = e.clientX - rect.left;
        dragCurrentY = e.clientY - rect.top;
      }

      // Highlight the node the user is hovering over as drop target
      const hoveredNode = (e.target as Element).closest('.node');
      if (hoveredNode !== dragTargetNode) {
        dragTargetNode?.classList.remove('drag-target');
        dragTargetNode = null;
        if (hoveredNode) {
          const hoveredId = getMermaidNodeId(hoveredNode);
          if (hoveredId && hoveredId !== sourceNodeId) {
            dragTargetNode = hoveredNode;
            dragTargetNode.classList.add('drag-target');
          }
        }
      }
    }
  }

  function handleMouseUp(e: MouseEvent) {
    if (isDragging && sourceNodeId) {
      e.stopPropagation();
      isDragging = false;

      // Clear drag target highlight
      dragTargetNode?.classList.remove('drag-target');
      dragTargetNode = null;

      const target = e.target as Element;
      console.log('[VisualEditor] MouseUp on target:', target);
      const targetNodeId = getMermaidNodeId(target);
      console.log('[VisualEditor] Dropped on node:', targetNodeId);
      if (targetNodeId && targetNodeId !== sourceNodeId) {
        const state = $inputStateStore;
        const newCode = state.code + `\n  ${sourceNodeId} --> ${targetNodeId}`;
        updateCodeStore({ code: newCode, updateDiagram: true });
      }
      sourceNodeId = null;
    }
  }

  function handleDoubleClick(e: MouseEvent) {
    if (isSpaceDown) return; // Space held = pan mode
    const target = e.target as Element;
    console.log(
      '[VisualEditor] Double click on target:',
      target,
      'tagName:',
      target.tagName,
      'className:',
      target.className
    );

    // Strict edge selector to prevent matching the whole graph
    const edgeLabelEl = target.closest('.edgeLabel, .edge-label, [class*="edgeLabel"]');
    // Ensure it's not actually a node label — double-click on edge label does nothing;
    // use the hover toolbar pencil button to edit.
    if (edgeLabelEl && !target.closest('.node')) {
      e.stopPropagation();
      return;
    }

    const nodeEl = target.closest('.node');
    console.log('[VisualEditor] closest .node:', nodeEl);
    if (nodeEl) {
      e.stopPropagation(); // Prevent pan-zoom zoom-in
      const nodeId = getMermaidNodeId(nodeEl);
      if (nodeId) {
        console.log('[VisualEditor] editing node ID:', nodeId);
        const labelEl = nodeEl.querySelector('.nodeLabel, .label');
        const text = labelEl ? (labelEl.textContent || '').trim() : '';

        editingNodeId = nodeId;
        editText = text.replace(/<br\s*\/?>/g, '\n');

        if (labelEl) {
          editingLabelEl = labelEl;
          (editingLabelEl as HTMLElement).style.visibility = 'hidden';

          const nodeRect = nodeEl.getBoundingClientRect();
          if (view) {
            const viewRect = view.getBoundingClientRect();
            // Textbox covers the entire width/height of the node
            editX = nodeRect.left - viewRect.left;
            editY = nodeRect.top - viewRect.top;
            editW = nodeRect.width;
            editH = nodeRect.height;

            // Exact scale calculation
            let scale = 1;
            if (nodeEl instanceof SVGGraphicsElement) {
              const bbox = nodeEl.getBBox();
              if (bbox.height > 0) scale = nodeRect.height / bbox.height;
            }
            const unscaledFontSize = parseFloat(window.getComputedStyle(labelEl).fontSize) || 16;
            editFontSize = unscaledFontSize * scale;
          }
        }
      } else {
        console.warn('[VisualEditor] Could not extract ID from node: ', nodeEl);
      }
      return;
    }

    if (
      target.closest('svg') &&
      !target.closest('.cluster') &&
      !target.closest('path') &&
      !target.closest('.edgeLabel, .edge-label, [class*="edgeLabel"]')
    ) {
      console.log('[VisualEditor] click fell through to background SVG. Creating new node.');
      e.stopPropagation();
      const state = $inputStateStore;
      let newCode = state.code.replace(/\r\n/g, '\n');
      const newNodeId = getNextNodeId(newCode);
      newCode += `\n  ${newNodeId}["New Node"]`;
      updateCodeStore({ code: newCode, updateDiagram: true });
    }
  }

  function handleKeyDownGlobal(e: KeyboardEvent) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // Don't delete if we are in an input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Delete selected edge
      if (selectedEdgePath && selectedEdgeSourceId && selectedEdgeTargetId) {
        deleteEdge(selectedEdgeSourceId, selectedEdgeTargetId, selectedEdgeIndex);
        return;
      }

      if (selectedNode) {
        const nodeId = getMermaidNodeId(selectedNode);
        if (nodeId) {
          const state = $inputStateStore;
          let newCode = state.code;

          // Very naive deletion: removes any line containing the node ID exactly.
          // This removes the node definition AND any connections it's part of.
          const escapedNodeId = nodeId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          const lines = newCode.split('\n');
          const regex = new RegExp(
            `(?:^|\\s)${escapedNodeId}(?:\\s*[\\[\\(\\{>]|\\s*-->|\\s*---|$)`
          );

          const newLines = lines.filter((line) => !regex.test(line));

          updateCodeStore({ code: newLines.join('\n'), updateDiagram: true });
          clearSelection();
        }
      }
    }
  }

  function deleteEdge(sourceId: string, targetId: string, edgeIndex: number) {
    const state = $inputStateStore;
    const lines = state.code.split('\n');
    const escapedSrc = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedTgt = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const edgeRegex = new RegExp(
      `^\\s*${escapedSrc}\\s*(?:-->|---|-.->|==>|--|==|-\\.-)[^\\n]*${escapedTgt}\\s*$`
    );
    // Count occurrences and only remove the one at edgeIndex (0-based)
    let matchCount = -1;
    const newLines = lines.filter((line) => {
      if (edgeRegex.test(line)) {
        matchCount++;
        // Remove only the Nth matching edge; keep the rest
        return matchCount !== edgeIndex;
      }
      return true;
    });
    updateCodeStore({ code: newLines.join('\n'), updateDiagram: true });
    clearEdgeSelection();
    hoveredEdgePath?.classList.remove('edge-hovered');
    hoveredEdgePath = null;
    hoveredEdgeSourceId = null;
    hoveredEdgeTargetId = null;
    hoveredEdgeIndex = -1;
  }

  function reverseEdge(sourceId: string, targetId: string) {
    const state = $inputStateStore;
    const lines = state.code.split('\n');
    const escapedSrc = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedTgt = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (let i = 0; i < lines.length; i++) {
      // Match: indent src spaces OPERATOR optional-|label| spaces tgt trailing
      const match = lines[i].match(
        new RegExp(
          `^(\\s*)(${escapedSrc})(\\s*)(-->|---|-.->|==>|--|==|-\\.-)((\\|[^|]*\\|)?)(\\s*)(${escapedTgt})(\\s*)$`
        )
      );
      if (match) {
        const [, indent, , , op, labelPart] = match;
        lines[i] = `${indent}${targetId} ${op}${labelPart} ${sourceId}`;
        break;
      }
    }
    updateCodeStore({ code: lines.join('\n'), updateDiagram: true });
    clearEdgeSelection();
    hoveredEdgePath?.classList.remove('edge-hovered');
    hoveredEdgePath = null;
    hoveredEdgeSourceId = null;
    hoveredEdgeTargetId = null;
    hoveredEdgeIndex = -1;
  }

  function saveEdit() {
    if (editingNodeId) {
      const state = $inputStateStore;
      let newCode = state.code;
      const textToSave = editText.replace(/\n/g, '<br/>');

      if (editingNodeId!.startsWith('NEW_EDGE:')) {
        const parts = editingNodeId!.split(':');
        const sourceId = parts[1];
        const targetId = parts[2];
        const edgeIndex = parts[3] !== undefined ? parseInt(parts[3], 10) : -1;
        const escapedSrc = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedTgt = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match a single edge line: src OPERATOR optional-|label| tgt
        const edgeLineRegex = new RegExp(
          `^(\\s*${escapedSrc}\\s*)(-->|---|-.->|==>|--|==|-\\.-)((\\|[^|]*\\|)?)(\\s*${escapedTgt}\\s*)$`
        );
        // Replace only the Nth matching line (edgeIndex 0-based); -1 = first match
        const lines = newCode.split('\n');
        let matchCount = -1;
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(edgeLineRegex);
          if (m) {
            matchCount++;
            if (matchCount === edgeIndex || edgeIndex < 0) {
              const [, pre, op, , , post] = m;
              if (!textToSave) {
                lines[i] = `${pre}${op}${post}`;
              } else {
                let newOp: string;
                if (op === '-->') newOp = `-->|${textToSave}|`;
                else if (op === '---') newOp = `---|${textToSave}|`;
                else if (op === '-.->') newOp = `-.->|${textToSave}|`;
                else if (op === '==>') newOp = `==>|${textToSave}|`;
                else newOp = `${op}|${textToSave}|`;
                lines[i] = `${pre}${newOp}${post}`;
              }
              break;
            }
          }
        }
        newCode = lines.join('\n');
      } else if (editingNodeId!.startsWith('EDGE:')) {
        const oldText = editingNodeId!.substring(5);
        if (oldText) {
          const lines = newCode.split('\n');
          const escapedOldText = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const labelPattern = new RegExp(`\\|${escapedOldText}\\|`);
          for (let i = 0; i < lines.length; i++) {
            if (!lines[i].match(/-->|---|-.->|==>|--|==|-\.-/)) continue;
            // If we know the directed source→target, verify this is the correct edge
            if (editingEdgeSource && editingEdgeTarget) {
              const escapedSrc = editingEdgeSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const escapedTgt = editingEdgeTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const directedRegex = new RegExp(`${escapedSrc}[^\\n]*${escapedTgt}`);
              if (!directedRegex.test(lines[i])) continue;
            }
            if (labelPattern.test(lines[i])) {
              lines[i] = lines[i].replace(labelPattern, `|${textToSave}|`);
              break;
            } else if (lines[i].includes(oldText)) {
              lines[i] = lines[i].replace(oldText, textToSave);
              break;
            }
          }
          newCode = lines.join('\n');
        }
      } else {
        // Always quote node labels so special chars like (), {}, [] don't break parsing
        const quotedLabel = `"${textToSave.replace(/"/g, "'")}"`;
        const escapedNodeId = editingNodeId!.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

        // Find and replace the node definition line-by-line to handle any content with special chars
        const lines = newCode.split('\n');
        let found = false;

        for (let i = 0; i < lines.length && !found; i++) {
          if (!lines[i].includes(editingNodeId!)) continue;

          // Find the opening bracket right after the node ID
          const nodeStartIdx = lines[i].indexOf(editingNodeId!);
          const afterNodeId = lines[i].substring(nodeStartIdx + editingNodeId!.length);
          const bracketMatch = afterNodeId.match(/^\s*([\[\(\{>])/);

          if (bracketMatch) {
            const openBracket = bracketMatch[1];
            const closeBracketMap: Record<string, string> = {
              '[': ']',
              '(': ')',
              '{': '}',
              '>': '<'
            };
            const closeBracket = closeBracketMap[openBracket];

            // Find the closing bracket
            const contentStart = nodeStartIdx + editingNodeId!.length + bracketMatch[0].length;
            const closeIdx = lines[i].lastIndexOf(closeBracket);

            if (closeIdx > contentStart) {
              const before = lines[i].substring(0, contentStart);
              const after = lines[i].substring(closeIdx);
              lines[i] = `${before}${quotedLabel}${after}`;
              found = true;
            }
          }
        }

        if (!found) {
          // Node doesn't exist; create it
          newCode += `\n  ${editingNodeId}[${quotedLabel}]`;
        } else {
          newCode = lines.join('\n');
        }
      }

      if (editingLabelEl) {
        (editingLabelEl as HTMLElement).style.visibility = 'visible';
        editingLabelEl = null;
      }

      updateCodeStore({ code: newCode, updateDiagram: true });
      editingNodeId = null;
      editingEdgeSource = null;
      editingEdgeTarget = null;
    }
  }

  function cancelEdit() {
    if (editingLabelEl) {
      (editingLabelEl as HTMLElement).style.visibility = 'visible';
      editingLabelEl = null;
    }
    editingNodeId = null;
    editingEdgeSource = null;
    editingEdgeTarget = null;
  }

  onMount(() => {
    if (view) {
      view.addEventListener('mousedown', handleMouseDown, true);
      view.addEventListener('mousemove', handleMouseMove, true);
      window.addEventListener('mouseup', handleMouseUp, true);
      view.addEventListener('dblclick', handleDoubleClick, true);
      window.addEventListener('keydown', handleKeyDownGlobal, true);
    }

    // Track Space for pan mode
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.code === 'Space' &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        isSpaceDown = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') isSpaceDown = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    setupPanZoomObserver();
    // Queue state changes to avoid race condition
    let pendingStateChange = Promise.resolve();
    stateStore.subscribe((state) => {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      pendingStateChange = pendingStateChange.then(() => handleStateChange(state).catch(() => {}));
    });

    return () => {
      if (view) {
        view.removeEventListener('mousedown', handleMouseDown, true);
        view.removeEventListener('mousemove', handleMouseMove, true);
        window.removeEventListener('mouseup', handleMouseUp, true);
        view.removeEventListener('dblclick', handleDoubleClick, true);
        window.removeEventListener('keydown', handleKeyDownGlobal, true);
      }
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  });
</script>

<div
  id="view"
  bind:this={view}
  class={[
    'relative h-full w-full',
    shouldShowGrid && `grid-bg-${$mode}`,
    error && 'opacity-50',
    isSpaceDown && 'grab-mode'
  ].join(' ')}>
  <div id="container" bind:this={container} class="h-full overflow-auto"></div>

  {#if isDragging}
    <!-- Absolute overlay for the drag line -->
    <svg class="pointer-events-none absolute top-0 left-0 z-40 h-full w-full">
      <line
        x1={dragStartX}
        y1={dragStartY}
        x2={dragCurrentX}
        y2={dragCurrentY}
        stroke="#3b82f6"
        stroke-width="3"
        stroke-dasharray="5,5" />
    </svg>
  {/if}

  {#if selectedNode}
    <!-- svelte-ignore a11y_consider_explicit_label -->
    <button
      class="quick-action-btn absolute z-50 flex cursor-pointer items-center justify-center rounded-full border border-white bg-indigo-500 text-white shadow-lg transition-transform hover:scale-110 hover:bg-indigo-600"
      style="left: {quickActionX}px; top: {quickActionY}px; width: {quickActionSize}px; height: {quickActionSize}px;"
      onclick={(e) => {
        e.stopPropagation();
        const selectedNodeId = getMermaidNodeId(selectedNode!);
        if (selectedNodeId) {
          const state = $inputStateStore;
          // Clean up carriage returns
          let newCode = state.code.replace(/\r\n/g, '\n');

          const newNodeId = getNextNodeId(newCode);
          newCode += `\n  ${newNodeId}["New Node"]`;
          newCode += `\n  ${selectedNodeId} --> ${newNodeId}`;
          updateCodeStore({ code: newCode, updateDiagram: true });
        }
      }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="60%"
        height="60%"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line
        ></svg>
    </button>
  {/if}

  {#if selectedEdgePath}
    <!-- Reverse direction button -->
    <button
      class="edge-action-btn absolute z-50 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 shadow hover:bg-slate-50"
      style="left: {selectedEdgeX - 40}px; top: {selectedEdgeY - 28}px;"
      title="Reverse direction"
      aria-label="Reverse edge direction"
      onclick={(e) => {
        e.stopPropagation();
        if (selectedEdgeSourceId && selectedEdgeTargetId) {
          reverseEdge(selectedEdgeSourceId, selectedEdgeTargetId);
        }
      }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path
        ><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path
        ></svg>
    </button>
    <!-- Edit label button -->
    <button
      class="edge-action-btn absolute z-50 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-indigo-200 bg-white text-indigo-500 shadow hover:bg-indigo-50"
      style="left: {selectedEdgeX - 12}px; top: {selectedEdgeY - 28}px;"
      title="Edit label"
      aria-label="Edit edge label"
      onclick={(e) => {
        e.stopPropagation();
        if (selectedEdgeSourceId && selectedEdgeTargetId) {
          editingEdgeSource = selectedEdgeSourceId;
          editingEdgeTarget = selectedEdgeTargetId;
          editingNodeId = `NEW_EDGE:${selectedEdgeSourceId}:${selectedEdgeTargetId}:${selectedEdgeIndex}`;
          editText = '';
          editX = selectedEdgeX - 40;
          editY = selectedEdgeY - 15;
          editW = 80;
          editH = 30;
          editFontSize = 14;
        } else {
          console.warn('Could not find source/target for edge:', selectedEdgePath);
        }
        clearEdgeSelection();
      }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
    </button>
    <!-- Delete edge button -->
    <button
      class="edge-action-btn absolute z-50 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-red-200 bg-white text-red-400 shadow hover:bg-red-50"
      style="left: {selectedEdgeX + 16}px; top: {selectedEdgeY - 28}px;"
      title="Delete edge"
      aria-label="Delete edge"
      onclick={(e) => {
        e.stopPropagation();
        if (selectedEdgeSourceId && selectedEdgeTargetId) {
          deleteEdge(selectedEdgeSourceId, selectedEdgeTargetId, selectedEdgeIndex);
        }
      }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><polyline points="3 6 5 6 21 6"></polyline><path
          d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path
        ><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4h6v2"></path></svg>
    </button>
  {/if}

  {#if editingNodeId}
    <textarea
      class={editingNodeId.startsWith('NEW_EDGE:')
        ? 'absolute z-100 flex resize-none items-center justify-center overflow-hidden rounded-md border-2 border-indigo-400 bg-indigo-50/95 p-1 text-center font-sans leading-tight text-indigo-950 shadow-xl outline-none focus:ring-4 focus:ring-indigo-500/30'
        : 'absolute z-100 m-0 resize-none overflow-hidden bg-transparent p-0 text-center font-sans leading-tight text-inherit focus:ring-0 focus:outline-none'}
      style="left: {editX}px; top: {editY}px; width: {Math.max(editW, 40)}px; height: {Math.max(
        editH,
        20
      )}px; font-size: {editFontSize}px;"
      bind:value={editText}
      onblur={saveEdit}
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          saveEdit();
        } else if (e.key === 'Escape') {
          cancelEdit();
        }
      }}
      autofocus
      placeholder={editingNodeId.startsWith('NEW_EDGE:') ? 'Edge Label' : ''}></textarea>
  {/if}
</div>

<style>
  :global(.drag-target rect),
  :global(.drag-target polygon),
  :global(.drag-target circle),
  :global(.drag-target path) {
    stroke: #22c55e !important;
    stroke-width: 3px !important;
    filter: drop-shadow(0 0 10px rgba(34, 197, 94, 0.6)) !important;
  }

  :global(.visual-selected rect),
  :global(.visual-selected polygon),
  :global(.visual-selected circle),
  :global(.visual-selected path) {
    stroke: #6366f1 !important;
    stroke-width: 3px !important;
    filter: drop-shadow(0 0 8px rgba(99, 102, 241, 0.4)) !important;
  }

  :global(.edge-hovered) {
    stroke: #6366f1 !important;
    stroke-width: 3px !important;
    filter: drop-shadow(0 0 8px rgba(99, 102, 241, 0.5)) !important;
    cursor: pointer !important;
  }

  /* DEBUG: visible red paths to verify hit area injection */
  :global(.edge-hit-area) {
    stroke: transparent !important;
    stroke-width: 50px !important;
    fill: none !important;
    cursor: pointer;
    opacity: 0.5;
  }

  :global(.edge-selected) {
    stroke: #4f46e5 !important;
    stroke-width: 4px !important;
    filter: drop-shadow(0 0 12px rgba(79, 70, 229, 0.7)) !important;
  }

  /* Readable edge label text */
  :global(.edgeLabel span),
  :global(.edgeLabel p),
  :global(.edgeLabel foreignObject) {
    font-size: 13px !important;
    line-height: 1.2 !important;
  }

  .grid-bg-light {
    background-size: 30px 30px;
    background-image: radial-gradient(circle, #e4e4e48c 2px, #0000 2px);
  }

  .grid-bg-dark {
    background-size: 30px 30px;
    background-image: radial-gradient(circle, #46464646 2px, #0000 2px);
  }

  :global(.grab-mode) {
    cursor: grab !important;
  }

  :global(.grab-mode:active) {
    cursor: grabbing !important;
  }
</style>
