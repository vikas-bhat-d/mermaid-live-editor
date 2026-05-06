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
    if (idAttr) {
      idAttr = idAttr.replace(/^[a-zA-Z0-9_]+-/, ''); // e.g. flowchart-
      idAttr = idAttr.replace(/-\d+$/, ''); // e.g. -95
      console.log('[VisualEditor] parsed node ID:', idAttr);
      return idAttr;
    }
    return null;
  }

  let isDragging = $state(false);
  let dragStartX = $state(0);
  let dragStartY = $state(0);
  let dragCurrentX = $state(0);
  let dragCurrentY = $state(0);
  let sourceNodeId = $state<string | null>(null);

  let editingNodeId = $state<string | null>(null);
  let editText = $state<string>('');
  let editX = $state(0);
  let editY = $state(0);
  let editW = $state(0);
  let editH = $state(0);

  function handleMouseDown(e: MouseEvent) {
    if (editingNodeId) return;
    const target = e.target as Element;
    console.log('[VisualEditor] MouseDown on target:', target);
    const nodeId = getMermaidNodeId(target);
    if (nodeId) {
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
    }
  }

  function handleMouseMove(e: MouseEvent) {
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
        import('svelte/store').then(({ get }) => {
          const state = get(inputStateStore);
          const newCode = state.code + `\n  ${sourceNodeId} --> ${targetNodeId}`;
          updateCodeStore({ code: newCode, updateDiagram: true });
        });
      }
      sourceNodeId = null;
    }
  }

  function handleDoubleClick(e: MouseEvent) {
    const target = e.target as Element;
    console.log('[VisualEditor] Double click on target:', target, 'tagName:', target.tagName, 'className:', target.className);
    
    const edgeLabelEl = target.closest('.edgeLabel');
    console.log('[VisualEditor] closest .edgeLabel:', edgeLabelEl);
    if (edgeLabelEl) {
      e.stopPropagation(); // Prevent pan-zoom zoom-in
      const text = (edgeLabelEl.textContent || '').trim();
      console.log('[VisualEditor] editing edge with text:', text);
      editingNodeId = `EDGE:${text}`;
      editText = text.replace(/<br\s*\/?>/g, '\n');
      const rect = edgeLabelEl.getBoundingClientRect();
      if (view) {
        const viewRect = view.getBoundingClientRect();
        editX = rect.left - viewRect.left;
        editY = rect.top - viewRect.top;
        editW = rect.width;
        editH = rect.height;
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
        const rect = nodeEl.getBoundingClientRect();
        const labelEl = nodeEl.querySelector('.nodeLabel, .label');
        const text = labelEl ? (labelEl.textContent || '').trim() : '';
        
        editingNodeId = nodeId;
        editText = text.replace(/<br\s*\/?>/g, '\n');
        
        if (view) {
          const viewRect = view.getBoundingClientRect();
          editX = rect.left - viewRect.left;
          editY = rect.top - viewRect.top;
          editW = rect.width;
          editH = rect.height;
        }
      } else {
        console.warn("[VisualEditor] Could not extract ID from node: ", nodeEl);
      }
      return;
    }

    if (target.closest('svg') && !target.closest('.cluster')) {
      console.log('[VisualEditor] click fell through to background SVG. Creating new node.');
      e.stopPropagation();
      import('svelte/store').then(({ get }) => {
        const state = get(inputStateStore);
        const newNodeId = `node${Date.now().toString().slice(-4)}`;
        const newCode = state.code + `\n  ${newNodeId}[New Node]`;
        updateCodeStore({ code: newCode, updateDiagram: true });
      });
    }
  }

  function saveEdit() {
    if (editingNodeId) {
      import('svelte/store').then(({ get }) => {
        const state = get(inputStateStore);
        let newCode = state.code;
        const textToSave = editText.replace(/\n/g, '<br/>');

        if (editingNodeId!.startsWith('EDGE:')) {
          const oldText = editingNodeId!.substring(5);
          if (oldText) {
            const escapedOldText = oldText.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const edgeRegex = new RegExp(`(\\||-)\\s*${escapedOldText}\\s*(\\||->)`, 'g');
            newCode = newCode.replace(edgeRegex, `$1${textToSave}$2`);
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
        
        updateCodeStore({ code: newCode, updateDiagram: true });
        editingNodeId = null;
      });
    }
  }

  onMount(() => {
    if (view) {
      view.addEventListener('mousedown', handleMouseDown, true);
      view.addEventListener('mousemove', handleMouseMove, true);
      window.addEventListener('mouseup', handleMouseUp, true);
      view.addEventListener('dblclick', handleDoubleClick, true);
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

  {#if editingNodeId}
    <textarea
      class="absolute bg-white dark:bg-gray-800 text-black dark:text-white border border-blue-500 p-2 z-50 rounded shadow-lg outline-none"
      style="left: {editX}px; top: {editY}px; width: {Math.max(editW, 120)}px; height: {Math.max(editH, 60)}px;"
      bind:value={editText}
      onblur={saveEdit}
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          saveEdit();
        } else if (e.key === 'Escape') {
          editingNodeId = null;
        }
      }}
      autofocus
    ></textarea>
  {/if}
</div>

<style>
  .grid-bg-light {
    background-size: 30px 30px;
    background-image: radial-gradient(circle, #e4e4e48c 2px, #0000 2px);
  }

  .grid-bg-dark {
    background-size: 30px 30px;
    background-image: radial-gradient(circle, #46464646 2px, #0000 2px);
  }
</style>
