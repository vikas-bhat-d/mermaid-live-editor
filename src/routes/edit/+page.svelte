<script lang="ts">
  import Card from '$/components/Card/Card.svelte';
  import Editor from '$/components/Editor.svelte';
  import ExportButtons from '$/components/ExportButtons.svelte';
  import { Button } from '$/components/ui/button';
  import * as Resizable from '$/components/ui/resizable';
  import View from '$/components/View.svelte';
  import type { EditorMode, Tab } from '$/types';
  import { PanZoomState } from '$/util/panZoom';
  import { freshStartCode, inputStateStore, stateStore, updateCodeStore } from '$/util/state';
  import { initHandler } from '$/util/util';
  import { onMount } from 'svelte';
  import CodeIcon from '~icons/custom/code';
  import GearIcon from '~icons/material-symbols/settings-outline-rounded';

  const panZoomState = new PanZoomState();

  const tabSelectHandler = (tab: Tab) => {
    const editorMode: EditorMode = tab.id === 'code' ? 'code' : 'config';
    updateCodeStore({ editorMode });
  };

  const editorTabs: Tab[] = [
    {
      icon: CodeIcon,
      id: 'code',
      title: 'Code'
    },
    {
      icon: GearIcon,
      id: 'config',
      title: 'Config'
    }
  ];

  let width = $state(0);
  let isMobile = $derived(width < 640);
  let isCodeClosed = $state(false);

  let codeHistory = $state<string[]>([]);
  let historyIndex = $state(-1);
  let isNavigatingHistory = false;
  let showFreshStartModal = $state(false);

  const UNDO_STORAGE_KEY = 'codeUndoStack';
  const MAX_UNDO_STEPS = 100;

  function persistUndoStack() {
    try {
      localStorage.setItem(
        UNDO_STORAGE_KEY,
        JSON.stringify({ history: codeHistory, index: historyIndex })
      );
    } catch {
      // localStorage full or unavailable — silently ignore
    }
  }

  onMount(() => {
    void initHandler();
    window.addEventListener('appinstalled', () => {
      // PWA installed event
    });

    // Restore persisted undo stack so Ctrl+Z/Y works after reload.
    try {
      const saved = localStorage.getItem(UNDO_STORAGE_KEY);
      if (saved) {
        const { history, index } = JSON.parse(saved) as { history: string[]; index: number };
        if (
          Array.isArray(history) &&
          typeof index === 'number' &&
          index >= 0 &&
          index < history.length
        ) {
          codeHistory = history;
          historyIndex = index;
        }
      }
    } catch {
      // Corrupted data — start fresh
    }

    const unsubscribe = inputStateStore.subscribe((state) => {
      if (isNavigatingHistory) {
        isNavigatingHistory = false;
        return;
      }
      if (historyIndex === -1 || codeHistory[historyIndex] !== state.code) {
        codeHistory = codeHistory.slice(0, historyIndex + 1);
        codeHistory.push(state.code);
        historyIndex++;
        // Cap to avoid unbounded localStorage growth
        if (codeHistory.length > MAX_UNDO_STEPS) {
          codeHistory = codeHistory.slice(codeHistory.length - MAX_UNDO_STEPS);
          historyIndex = codeHistory.length - 1;
        }
        persistUndoStack();
      }
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // Let Monaco handle undo/redo when the code editor textarea is focused.
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === 'TEXTAREA' || (active as HTMLElement).closest?.('.monaco-editor'))
      )
        return;
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  function undo() {
    if (historyIndex > 0) {
      historyIndex--;
      isNavigatingHistory = true;
      updateCodeStore({ code: codeHistory[historyIndex], updateDiagram: true });
      persistUndoStack();
    }
  }

  function redo() {
    if (historyIndex < codeHistory.length - 1) {
      historyIndex++;
      isNavigatingHistory = true;
      updateCodeStore({ code: codeHistory[historyIndex], updateDiagram: true });
      persistUndoStack();
    }
  }

  function startFresh() {
    showFreshStartModal = false;
    // Clear undo history and reset to fresh start code
    codeHistory = [freshStartCode];
    historyIndex = 0;
    persistUndoStack();
    updateCodeStore({ code: freshStartCode, updateDiagram: true });
  }

  let editorPane: Resizable.Pane | undefined;

  $effect(() => {
    if (isMobile) {
      editorPane?.resize(50);
    }
  });

  function toggleCode() {
    if (isCodeClosed) {
      editorPane?.expand();
      isCodeClosed = false;
    } else {
      editorPane?.collapse();
      isCodeClosed = true;
    }
  }
</script>

<div class="flex h-full flex-col overflow-hidden">
  <div class="flex flex-1 flex-col overflow-hidden" bind:clientWidth={width}>
    <div class="size-full">
      <Resizable.PaneGroup
        direction="horizontal"
        autoSaveId="liveEditor"
        class="relative gap-4 p-2 pt-0 sm:gap-0 sm:p-6 sm:pt-0">
        <Resizable.Pane
          bind:this={editorPane}
          defaultSize={35}
          minSize={10}
          maxSize={60}
          collapsible
          collapsedSize={0}
          onCollapse={() => (isCodeClosed = true)}
          onExpand={() => (isCodeClosed = false)}>
          <div class="flex h-full flex-col gap-4 pr-2 sm:gap-6">
            <Card
              onselect={tabSelectHandler}
              isOpen
              tabs={editorTabs}
              activeTabID={$stateStore.editorMode}
              isClosable={false}>
              <Editor {isMobile} />
            </Card>
          </div>
        </Resizable.Pane>
        <Resizable.Handle
          class={[
            'hidden w-2 cursor-col-resize bg-gray-200 transition-colors hover:bg-gray-300 sm:block',
            isCodeClosed && 'pointer-events-none opacity-0'
          ]} />

        <Resizable.Pane minSize={15} class="relative flex h-full flex-1 flex-col overflow-hidden">
          <div class="absolute top-4 left-4 z-60 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              class="rounded-md border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 shadow-md transition-all hover:bg-gray-50"
              onclick={toggleCode}>
              {isCodeClosed ? 'Show Code' : 'Hide Code'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              class="rounded-md border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 shadow-md transition-all hover:bg-gray-50 disabled:opacity-50"
              onclick={undo}
              disabled={historyIndex <= 0}>
              Undo
            </Button>
            <Button
              variant="outline"
              size="sm"
              class="rounded-md border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 shadow-md transition-all hover:bg-gray-50 disabled:opacity-50"
              onclick={redo}
              disabled={historyIndex >= codeHistory.length - 1}>
              Redo
            </Button>
            <Button
              variant="outline"
              size="sm"
              class="rounded-md border-red-300 bg-white px-3 py-1.5 font-medium text-red-600 shadow-md transition-all hover:bg-red-50"
              onclick={() => (showFreshStartModal = true)}>
              Start Fresh
            </Button>
          </div>
          <div class="absolute top-4 right-4 z-60">
            <ExportButtons />
          </div>
          <View {panZoomState} shouldShowGrid={$stateStore.grid} />
        </Resizable.Pane>
      </Resizable.PaneGroup>
    </div>
  </div>
</div>

{#if showFreshStartModal}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    onclick={() => (showFreshStartModal = false)}>
    <div
      class="mx-4 max-w-sm rounded-lg bg-white p-6 shadow-lg"
      onclick={(e) => e.stopPropagation()}>
      <h2 class="mb-2 text-lg font-bold text-gray-900">Start Fresh?</h2>
      <p class="mb-6 text-gray-600">
        This will clear all your work and reset the diagram. All undo/redo history will be lost.
      </p>
      <div class="flex justify-end gap-3">
        <Button
          variant="outline"
          size="sm"
          class="rounded-md border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 hover:bg-gray-50"
          onclick={() => (showFreshStartModal = false)}>
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          class="rounded-md border-red-300 bg-red-50 px-4 py-2 font-medium text-red-600 hover:bg-red-100"
          onclick={startFresh}>
          Yes, Start Fresh
        </Button>
      </div>
    </div>
  </div>
{/if}
