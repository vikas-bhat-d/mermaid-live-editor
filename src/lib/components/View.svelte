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
    console.log('[VisualEditor] getMermaidNodeId called. target:', element, 'found closest .node:', nodeEl);
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

  function getNextNodeId(code: string): string {
    const matches = [...code.matchAll(/\bn(\d+)\b/g)];
    let max = 0;
    for (const match of matches) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
    return `n${max + 1}`;
  }

  let isDragging = $state(false);
  let dragStartX = $state(0);
  let dragStartY = $state(0);
  let dragCurrentX = $state(0);
  let dragCurrentY = $state(0);
  let sourceNodeId = $state<string | null>(null);

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
        quickActionX = rect.left - viewRect.left + (rect.width / 2) - (quickActionSize / 2);
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
    const target = e.target as Element;
    console.log('[VisualEditor] MouseDown on target:', target);
    
    // Check if clicking the quick action button
    if (target.closest('.quick-action-btn')) {
      return; // Handled by its own click listener
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
      if (pathEl && !target.closest('.edgeLabel, .node, .quick-action-btn, .edge-pencil-btn')) {
        if (hoveredEdgePath !== pathEl) {
          hoveredEdgePath = pathEl;
          const pathRect = pathEl.getBoundingClientRect();
          const viewRect = view?.getBoundingClientRect();
          if (viewRect) {
            hoveredEdgeX = pathRect.left - viewRect.left + (pathRect.width / 2);
            hoveredEdgeY = pathRect.top - viewRect.top + (pathRect.height / 2);
          }
        }
      } else if (!target.closest('.edge-pencil-btn')) {
        // SVG paths are very thin (1px). To prevent the pencil from disappearing 
        // the moment the mouse slips off the 1px line, we keep the pencil visible 
        // as long as the mouse is within a 40px magnetic radius of it!
        if (hoveredEdgePath && view) {
          const viewRect = view.getBoundingClientRect();
          const mouseX = e.clientX - viewRect.left;
          const mouseY = e.clientY - viewRect.top;
          const dist = Math.hypot(mouseX - hoveredEdgeX, mouseY - hoveredEdgeY);
          if (dist > 40) {
            hoveredEdgePath = null;
          }
        } else {
          hoveredEdgePath = null;
        }
      }
    } else {
      hoveredEdgePath = null;
    }

    if (isDragging) {
      e.stopPropagation(); // Prevent pan-zoom dragging
      const rect = view?.getBoundingClientRect();
      if (rect) {
        dragCurrentX = e.clientX - rect.left;
        dragCurrentY = e.clientY - rect.top;
      }
    }
  }

  function handleMouseUp(e: MouseEvent) {
    if (isDragging && sourceNodeId) {
      e.stopPropagation();
      isDragging = false;
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
    const target = e.target as Element;
    console.log('[VisualEditor] Double click on target:', target, 'tagName:', target.tagName, 'className:', target.className);
    
    // Strict edge selector to prevent matching the whole graph
    const edgeLabelEl = target.closest('.edgeLabel, .edge-label, [class*="edgeLabel"]');
    // Ensure it's not actually a node label
    if (edgeLabelEl && !target.closest('.node')) {
      e.stopPropagation(); // Prevent pan-zoom zoom-in
      const text = (edgeLabelEl.textContent || '').trim();
      console.log('[VisualEditor] editing edge with text:', text);
      if (text) {
        editingNodeId = `EDGE:${text}`;
        editText = text.replace(/<br\s*\/?>/g, '\n');
        
        editingLabelEl = edgeLabelEl;
        (editingLabelEl as HTMLElement).style.visibility = 'hidden';
        
        const rect = edgeLabelEl.getBoundingClientRect();
        if (view) {
          const viewRect = view.getBoundingClientRect();
          editX = rect.left - viewRect.left;
          editY = rect.top - viewRect.top;
          editW = rect.width;
          editH = rect.height;
          
          let scale = 1;
          if (edgeLabelEl instanceof SVGGraphicsElement) {
             const bbox = edgeLabelEl.getBBox();
             if (bbox.height > 0) scale = rect.height / bbox.height;
          } else {
             // Fallback if not an SVG element
             scale = rect.height / (edgeLabelEl.clientHeight || 20);
          }
          const unscaledFontSize = parseFloat(window.getComputedStyle(edgeLabelEl).fontSize) || 14;
          editFontSize = unscaledFontSize * scale;
        }
      }
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
        console.warn("[VisualEditor] Could not extract ID from node: ", nodeEl);
      }
      return;
    }

    if (target.closest('svg') && !target.closest('.cluster') && !target.closest('path') && !target.closest('.edgeLabel, .edge-label, [class*="edgeLabel"]')) {
      console.log('[VisualEditor] click fell through to background SVG. Creating new node.');
      e.stopPropagation();
      const state = $inputStateStore;
      let newCode = state.code.replace(/\r\n/g, '\n');
      const newNodeId = getNextNodeId(newCode);
      newCode += `\n  ${newNodeId}[New Node]`;
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
          const regex = new RegExp(`(?:^|\\s)${escapedNodeId}(?:\\s*[\\[\\(\\{>]|\\s*-->|\\s*---|$)`);
          
          const newLines = lines.filter(line => !regex.test(line));
          
          updateCodeStore({ code: newLines.join('\n'), updateDiagram: true });
          clearSelection();
        }
      }
    }
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
        const regex = new RegExp(`(${sourceId}\\s*(?:-->|---|-.->|==>|--|==|-\\.-)\\s*${targetId})`);
        const match = newCode.match(regex);
        if (match && textToSave) {
          const edgeOpMatch = match[1].match(/(-->|---|-.->|==>|--|==|-\.-)/);
          if (edgeOpMatch) {
             const op = edgeOpMatch[1];
             let newOp = op;
             if (op === '-->') newOp = `-->|${textToSave}|`;
             else if (op === '---') newOp = `---|${textToSave}|`;
             else if (op === '-.->') newOp = `-.->|${textToSave}|`;
             else if (op === '==>') newOp = `==>|${textToSave}|`;
             else newOp = `${op}|${textToSave}|`; // Fallback
             
             newCode = newCode.replace(match[1], `${sourceId} ${newOp} ${targetId}`);
          }
        }
      } else if (editingNodeId!.startsWith('EDGE:')) {
        const oldText = editingNodeId!.substring(5);
        if (oldText) {
          // Extremely robust string replace for edge lines
          const lines = newCode.split('\n');
          for (let i = 0; i < lines.length; i++) {
            // Check if line looks like an edge connection and contains the old text
            if (lines[i].includes(oldText) && lines[i].match(/-->|---|-.->|==>|--|==|-\.-/)) {
               lines[i] = lines[i].replace(oldText, textToSave);
            }
          }
          newCode = lines.join('\n');
        }
      } else {
        const escapedNodeId = editingNodeId!.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const nodeRegex = new RegExp(`(${escapedNodeId}\\s*[\\[\\(\\{>])([^\\]\\)\\}\\>]+)([\\]\\)\\}\\>])`);
        const match = newCode.match(nodeRegex);
        if (match) {
          newCode = newCode.replace(nodeRegex, `$1${textToSave}$3`);
        } else {
          newCode += `\n  ${editingNodeId}[${textToSave}]`;
        }
      }
      
      if (editingLabelEl) {
        (editingLabelEl as HTMLElement).style.visibility = 'visible';
        editingLabelEl = null;
      }
      
      updateCodeStore({ code: newCode, updateDiagram: true });
      editingNodeId = null;
    }
  }

  function cancelEdit() {
    if (editingLabelEl) {
      (editingLabelEl as HTMLElement).style.visibility = 'visible';
      editingLabelEl = null;
    }
    editingNodeId = null;
  }

  onMount(() => {
    if (view) {
      view.addEventListener('mousedown', handleMouseDown, true);
      view.addEventListener('mousemove', handleMouseMove, true);
      window.addEventListener('mouseup', handleMouseUp, true);
      view.addEventListener('dblclick', handleDoubleClick, true);
      window.addEventListener('keydown', handleKeyDownGlobal, true);
    }
    
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
    };
  });
</script>

<FontAwesome bind:waitForFontAwesomeToLoad />

<div
  id="view"
  bind:this={view}
  class={['h-full w-full relative', shouldShowGrid && `grid-bg-${$mode}`, error && 'opacity-50']}
>
  <div id="container" bind:this={container} class="h-full overflow-auto"></div>

  {#if isDragging}
    <!-- Absolute overlay for the drag line -->
    <svg class="absolute top-0 left-0 w-full h-full pointer-events-none z-40">
      <line x1={dragStartX} y1={dragStartY} x2={dragCurrentX} y2={dragCurrentY} stroke="#3b82f6" stroke-width="3" stroke-dasharray="5,5" />
    </svg>
  {/if}

  {#if selectedNode}
    <button 
      class="quick-action-btn absolute z-50 flex items-center justify-center bg-indigo-500 text-white rounded-full shadow-lg hover:bg-indigo-600 hover:scale-110 transition-transform cursor-pointer border border-white"
      style="left: {quickActionX}px; top: {quickActionY}px; width: {quickActionSize}px; height: {quickActionSize}px;"
      onclick={(e) => {
        e.stopPropagation();
        const selectedNodeId = getMermaidNodeId(selectedNode!);
        if (selectedNodeId) {
          const state = $inputStateStore;
          // Clean up carriage returns
          let newCode = state.code.replace(/\r\n/g, '\n');
          
          const newNodeId = getNextNodeId(newCode);
          newCode += `\n  ${newNodeId}[New Node]`;
          newCode += `\n  ${selectedNodeId} --> ${newNodeId}`;
          updateCodeStore({ code: newCode, updateDiagram: true });
        }
      }}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="60%" height="60%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
    </button>
  {/if}

  {#if hoveredEdgePath}
    <button 
      class="edge-pencil-btn absolute z-50 flex items-center justify-center w-6 h-6 bg-white text-indigo-500 rounded-full shadow border border-indigo-200 hover:bg-indigo-50 cursor-pointer"
      style="left: {hoveredEdgeX - 12}px; top: {hoveredEdgeY - 12}px;"
      onmouseover={() => hoveredEdgePath = hoveredEdgePath}
      onclick={(e) => {
        e.stopPropagation();
        let sourceId = null;
        let targetId = null;
        
        // Try class names first
        hoveredEdgePath!.classList.forEach(c => {
          if (c.startsWith('LS-')) sourceId = c.substring(3);
          if (c.startsWith('LE-')) targetId = c.substring(3);
        });

        // Fallback to ID
        if (!sourceId && hoveredEdgePath!.id) {
           const match = hoveredEdgePath!.id.match(/L[_-](.+?)[_-](.+?)[_-]\d+$/);
           if (match) {
              sourceId = match[1];
              targetId = match[2];
           }
        }

        if (sourceId && targetId) {
          editingNodeId = `NEW_EDGE:${sourceId}:${targetId}`;
          editText = '';
          editX = hoveredEdgeX - 40;
          editY = hoveredEdgeY - 15;
          editW = 80;
          editH = 30;
          editFontSize = 14;
        } else {
          console.warn("Could not find source/target for edge:", hoveredEdgePath);
        }
        hoveredEdgePath = null;
      }}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
    </button>
  {/if}

  {#if editingNodeId}
    <textarea
      class={editingNodeId.startsWith('NEW_EDGE:') 
        ? "absolute bg-indigo-50/95 text-indigo-950 font-sans border-2 border-indigo-400 focus:ring-4 focus:ring-indigo-500/30 z-[100] rounded-md shadow-xl outline-none resize-none overflow-hidden text-center p-1 flex items-center justify-center leading-tight" 
        : "absolute bg-transparent text-inherit font-sans focus:ring-0 focus:outline-none z-[100] resize-none overflow-hidden text-center p-0 m-0 leading-tight"}
      style="left: {editX}px; top: {editY}px; width: {Math.max(editW, 40)}px; height: {Math.max(editH, 20)}px; font-size: {editFontSize}px;"
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
      placeholder={editingNodeId.startsWith('NEW_EDGE:') ? "Edge Label" : ""}
    ></textarea>
  {/if}
</div>

<style>
  :global(.visual-selected rect),
  :global(.visual-selected polygon),
  :global(.visual-selected circle),
  :global(.visual-selected path) {
    stroke: #6366f1 !important;
    stroke-width: 3px !important;
    filter: drop-shadow(0 0 8px rgba(99, 102, 241, 0.4)) !important;
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
