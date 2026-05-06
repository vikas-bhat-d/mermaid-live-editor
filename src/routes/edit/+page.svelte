<script lang="ts">
  import Card from '$/components/Card/Card.svelte';
  import Editor from '$/components/Editor.svelte';
  import { Button } from '$/components/ui/button';
  import * as Resizable from '$/components/ui/resizable';
  import View from '$/components/View.svelte';
  import type { EditorMode, Tab } from '$/types';
  import { PanZoomState } from '$/util/panZoom';
  import { inputStateStore, stateStore, updateCodeStore } from '$/util/state';
  import { logEvent } from '$/util/stats';
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

  onMount(async () => {
    await initHandler();
    window.addEventListener('appinstalled', () => {
      logEvent('pwaInstalled', { isMobile });
    });

    const unsubscribe = inputStateStore.subscribe((state) => {
      if (isNavigatingHistory) {
        isNavigatingHistory = false;
        return;
      }
      if (historyIndex === -1 || codeHistory[historyIndex] !== state.code) {
        codeHistory = codeHistory.slice(0, historyIndex + 1);
        codeHistory.push(state.code);
        historyIndex++;
      }
    });

    return () => unsubscribe();
  });

  function undo() {
    if (historyIndex > 0) {
      historyIndex--;
      isNavigatingHistory = true;
      updateCodeStore({ code: codeHistory[historyIndex], updateDiagram: true });
    }
  }

  function redo() {
    if (historyIndex < codeHistory.length - 1) {
      historyIndex++;
      isNavigatingHistory = true;
      updateCodeStore({ code: codeHistory[historyIndex], updateDiagram: true });
    }
  }

  let editorPane: Resizable.Pane | undefined;
  $effect(() => {
    if (isMobile) {
      editorPane?.resize(50);
    }
  });
</script>

<div class="flex h-full flex-col overflow-hidden">
  <div class="flex flex-1 flex-col overflow-hidden" bind:clientWidth={width}>
    <div class="size-full">
      <Resizable.PaneGroup
        direction="horizontal"
        autoSaveId="liveEditor"
        class="relative gap-4 p-2 pt-0 sm:gap-0 sm:p-6 sm:pt-0">
        {#if !isCodeClosed}
          <Resizable.Pane bind:this={editorPane} defaultSize={35} minSize={10} maxSize={60}>
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
            class="hidden w-2 cursor-col-resize bg-gray-200 transition-colors hover:bg-gray-300 sm:block" />
        {/if}

        <Resizable.Pane minSize={15} class="relative flex h-full flex-1 flex-col overflow-hidden">
          <div class="absolute top-4 left-4 z-[60] flex gap-2">
            <Button
              variant="outline"
              size="sm"
              class="rounded-md border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 shadow-md transition-all hover:bg-gray-50"
              onclick={() => (isCodeClosed = !isCodeClosed)}>
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
          </div>
          <View {panZoomState} shouldShowGrid={$stateStore.grid} />
        </Resizable.Pane>
      </Resizable.PaneGroup>
    </div>
  </div>
</div>
