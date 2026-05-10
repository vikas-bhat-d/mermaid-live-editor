<script lang="ts">
  import type { State, ValidatedState } from '$/types';
  import { recordRenderTime, shouldRefreshView } from '$/util/autoSync';
  import { render as renderDiagram } from '$/util/mermaid';
  import { PanZoomState } from '$/util/panZoom';
  import { inputStateStore, stateStore, updateCodeStore } from '$/util/state';
  import { saveStatistics } from '$/util/stats';
  import FontAwesome, { mayContainFontAwesome } from '$lib/components/FontAwesome.svelte';
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
  let waitForFontAwesomeToLoad: FontAwesome['waitForFontAwesomeToLoad'] | undefined = $state();

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

        if (mayContainFontAwesome(code)) {
          await waitForFontAwesomeToLoad?.();
        }

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
  let hoveredEdgeX = $state(0);
  let hoveredEdgeY = $state(0);
  let hoveredEdgeSourceId = $state<string | null>(null);
  let hoveredEdgeTargetId = $state<string | null>(null);
  let editingEdgeSource: string | null = null;
  let editingEdgeTarget: string | null = null;

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
      clearSelection();
    }
  }

  function handleMouseMove(e: MouseEvent) {
    const target = e.target as Element;

    // Handle Edge Hover Quick Actions
    if (!isDragging && !editingNodeId) {
      const pathEl = target.closest('.flowchart-link, path[class*="edge-pattern"]');
      if (pathEl && !target.closest('.edgeLabel, .node, .quick-action-btn, .edge-action-btn')) {
        if (hoveredEdgePath !== pathEl) {
          // Remove glow from previous edge
          if (hoveredEdgePath) hoveredEdgePath.classList.remove('edge-hovered');
          hoveredEdgePath = pathEl;
          hoveredEdgePath.classList.add('edge-hovered');
          // Extract source/target IDs from path element classes
          hoveredEdgeSourceId = null;
          hoveredEdgeTargetId = null;
          pathEl.classList.forEach((c) => {
            if (c.startsWith('LS-')) hoveredEdgeSourceId = stripMermaidId(c.substring(3));
            if (c.startsWith('LE-')) hoveredEdgeTargetId = stripMermaidId(c.substring(3));
          });
          // Fallback: parse data-id or id attribute (Mermaid format: L_sourceId_targetId_index)
          if (!hoveredEdgeSourceId || !hoveredEdgeTargetId) {
            const dataId = pathEl.getAttribute('data-id') || pathEl.id || '';
            // Strip optional "graph-N-" prefix, then match L_<middle>_<index>
            const dataMatch = dataId.replace(/^graph-\d+-/, '').match(/^L[_-](.+)[_-](\d+)$/);
            if (dataMatch) {
              const middle = dataMatch[1]; // e.g. "n2_n3" from "L_n2_n3_0"
              const src = $inputStateStore.code;
              const idExists = (id: string) => {
                const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(?:^|\\s)${esc}(?:\\s*[\\[\\(\\{>]|\\s*-->|\\s*---|$)`).test(
                  src
                );
              };
              // Try every possible underscore split: "a_b_c" → try ["a","b_c"], ["a_b","c"]
              const tokens = middle.split('_');
              for (let i = 1; i < tokens.length; i++) {
                const s = tokens.slice(0, i).join('_');
                const t = tokens.slice(i).join('_');
                if (idExists(s) && idExists(t)) {
                  hoveredEdgeSourceId = s;
                  hoveredEdgeTargetId = t;
                  break;
                }
              }
            }
          }
          console.log(
            '[VisualEditor] Edge hover IDs:',
            hoveredEdgeSourceId,
            '->',
            hoveredEdgeTargetId
          );
          const pathRect = pathEl.getBoundingClientRect();
          const viewRect = view?.getBoundingClientRect();
          if (viewRect) {
            hoveredEdgeX = pathRect.left - viewRect.left + pathRect.width / 2;
            hoveredEdgeY = pathRect.top - viewRect.top + pathRect.height / 2;
          }
        }
      } else if (!target.closest('.edge-action-btn')) {
        // SVG paths are very thin (1px). To prevent the pencil from disappearing
        // the moment the mouse slips off the 1px line, we keep the pencil visible
        // as long as the mouse is within a 40px magnetic radius of it!
        if (hoveredEdgePath && view) {
          const viewRect = view.getBoundingClientRect();
          const mouseX = e.clientX - viewRect.left;
          const mouseY = e.clientY - viewRect.top;
          const dist = Math.hypot(mouseX - hoveredEdgeX, mouseY - hoveredEdgeY);
          if (dist > 60) {
            hoveredEdgePath.classList.remove('edge-hovered');
            hoveredEdgePath = null;
            hoveredEdgeSourceId = null;
            hoveredEdgeTargetId = null;
          }
        } else {
          hoveredEdgePath?.classList.remove('edge-hovered');
          hoveredEdgePath = null;
          hoveredEdgeSourceId = null;
          hoveredEdgeTargetId = null;
        }
      }
    } else {
      hoveredEdgePath?.classList.remove('edge-hovered');
      hoveredEdgePath = null;
      hoveredEdgeSourceId = null;
      hoveredEdgeTargetId = null;
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

  function deleteEdge(sourceId: string, targetId: string) {
    const state = $inputStateStore;
    const lines = state.code.split('\n');
    const escapedSrc = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedTgt = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match a line that is purely an edge from sourceId to targetId (with optional label)
    const edgeRegex = new RegExp(
      `^\\s*${escapedSrc}\\s*(?:-->|---|-.->|==>|--|==|-\\.-)[^\\n]*${escapedTgt}\\s*$`
    );
    const newLines = lines.filter((line) => !edgeRegex.test(line));
    updateCodeStore({ code: newLines.join('\n'), updateDiagram: true });
    hoveredEdgePath = null;
    hoveredEdgeSourceId = null;
    hoveredEdgeTargetId = null;
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
    hoveredEdgePath = null;
    hoveredEdgeSourceId = null;
    hoveredEdgeTargetId = null;
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
        const escapedSrc = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedTgt = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(
          `(${escapedSrc}\\s*(?:-->|---|-.->|==>|--|==|-\\.-)[^\\n]*?)(${escapedTgt})`
        );
        const match = newCode.match(regex);
        if (match) {
          const fullEdgeSegment = match[1];
          const edgeOpMatch = fullEdgeSegment.match(/(-->|---|-.->|==>|--|==|-\.-)/);
          if (edgeOpMatch) {
            const op = edgeOpMatch[1];
            // If empty text submitted, just remove old label
            if (!textToSave) {
              // strip any existing |label|
              newCode = newCode.replace(
                new RegExp(
                  `(${escapedSrc}\\s*)(?:-->|---|-.->|==>|--|==|-\\.-)(\\|[^|]*\\|)?(\\s*${escapedTgt})`
                ),
                `$1${op}$3`
              );
            } else {
              let newOp: string;
              if (op === '-->') newOp = `-->|${textToSave}|`;
              else if (op === '---') newOp = `---|${textToSave}|`;
              else if (op === '-.->') newOp = `-.->|${textToSave}|`;
              else if (op === '==>') newOp = `==>|${textToSave}|`;
              else newOp = `${op}|${textToSave}|`;
              newCode = newCode.replace(
                new RegExp(
                  `(${escapedSrc}\\s*)(?:-->|---|-.->|==>|--|==|-\\.-)(\\|[^|]*\\|)?(\\s*${escapedTgt})`
                ),
                `$1${newOp}$3`
              );
            }
          }
        }
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
        // Match both quoted ("...") and unquoted labels inside node brackets
        const nodeRegex = new RegExp(
          `(${escapedNodeId}\\s*[\\[\\(\\{>])"?([^"\\]\\)\\}\\>]*)"?([\\]\\)\\}\\>])`
        );
        const match = newCode.match(nodeRegex);
        if (match) {
          newCode = newCode.replace(nodeRegex, `$1${quotedLabel}$3`);
        } else {
          newCode += `\n  ${editingNodeId}[${quotedLabel}]`;
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

<FontAwesome bind:waitForFontAwesomeToLoad />

<div
  id="view"
  bind:this={view}
  class={['relative h-full w-full', shouldShowGrid && `grid-bg-${$mode}`, error && 'opacity-50']}>
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

  {#if hoveredEdgePath}
    <!-- Reverse direction button -->
    <button
      class="edge-action-btn absolute z-50 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 shadow hover:bg-slate-50"
      style="left: {hoveredEdgeX - 40}px; top: {hoveredEdgeY - 12}px;"
      title="Reverse direction"
      aria-label="Reverse edge direction"
      onmouseover={() => (hoveredEdgePath = hoveredEdgePath)}
      onfocus={() => (hoveredEdgePath = hoveredEdgePath)}
      onclick={(e) => {
        e.stopPropagation();
        if (hoveredEdgeSourceId && hoveredEdgeTargetId) {
          reverseEdge(hoveredEdgeSourceId, hoveredEdgeTargetId);
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
      style="left: {hoveredEdgeX - 12}px; top: {hoveredEdgeY - 12}px;"
      title="Edit label"
      aria-label="Edit edge label"
      onmouseover={() => (hoveredEdgePath = hoveredEdgePath)}
      onfocus={() => (hoveredEdgePath = hoveredEdgePath)}
      onclick={(e) => {
        e.stopPropagation();
        if (hoveredEdgeSourceId && hoveredEdgeTargetId) {
          editingEdgeSource = hoveredEdgeSourceId;
          editingEdgeTarget = hoveredEdgeTargetId;
          editingNodeId = `NEW_EDGE:${hoveredEdgeSourceId}:${hoveredEdgeTargetId}`;
          editText = '';
          editX = hoveredEdgeX - 40;
          editY = hoveredEdgeY - 15;
          editW = 80;
          editH = 30;
          editFontSize = 14;
        } else {
          console.warn('Could not find source/target for edge:', hoveredEdgePath);
        }
        hoveredEdgePath = null;
        hoveredEdgeSourceId = null;
        hoveredEdgeTargetId = null;
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
      style="left: {hoveredEdgeX + 16}px; top: {hoveredEdgeY - 12}px;"
      title="Delete edge"
      aria-label="Delete edge"
      onmouseover={() => (hoveredEdgePath = hoveredEdgePath)}
      onfocus={() => (hoveredEdgePath = hoveredEdgePath)}
      onclick={(e) => {
        e.stopPropagation();
        if (hoveredEdgeSourceId && hoveredEdgeTargetId) {
          deleteEdge(hoveredEdgeSourceId, hoveredEdgeTargetId);
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
        ? 'absolute z-[100] flex resize-none items-center justify-center overflow-hidden rounded-md border-2 border-indigo-400 bg-indigo-50/95 p-1 text-center font-sans leading-tight text-indigo-950 shadow-xl outline-none focus:ring-4 focus:ring-indigo-500/30'
        : 'absolute z-[100] m-0 resize-none overflow-hidden bg-transparent p-0 text-center font-sans leading-tight text-inherit focus:ring-0 focus:outline-none'}
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
  }

  .grid-bg-light {
    background-size: 30px 30px;
    background-image: radial-gradient(circle, #e4e4e48c 2px, #0000 2px);
  }

  .grid-bg-dark {
    background-size: 30px 30px;
    background-image: radial-gradient(circle, #46464646 2px, #0000 2px);
  }
</style>
