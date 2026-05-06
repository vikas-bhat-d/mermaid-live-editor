<script lang="ts">
  import Actions from '$/components/Actions.svelte';
  import Card from '$/components/Card/Card.svelte';
  import DiagramDocButton from '$/components/DiagramDocumentationButton.svelte';
  import Editor from '$/components/Editor.svelte';
  import EnhancedEditsButton from '$/components/EnhancedEditsButton.svelte';
  import History from '$/components/History/History.svelte';
  import McWrapper from '$/components/McWrapper.svelte';
  import MermaidChartIcon from '$/components/MermaidChartIcon.svelte';
  import EditorChooserModal from '$/components/migration/EditorChooserModal.svelte';
  import Navbar from '$/components/Navbar.svelte';
  import PanZoomToolbar from '$/components/PanZoomToolbar.svelte';
  import Preset from '$/components/Preset.svelte';
  import Share from '$/components/Share.svelte';
  import SyncRoughToolbar from '$/components/SyncRoughToolbar.svelte';
  import { Button } from '$/components/ui/button';
  import * as Resizable from '$/components/ui/resizable';
  import { Switch } from '$/components/ui/switch';
  import { Toggle } from '$/components/ui/toggle';
  import VersionSecurityToolbar from '$/components/VersionSecurityToolbar.svelte';
  import View from '$/components/View.svelte';
  import type { EditorMode, Tab } from '$/types';
  import { shouldShowEditorChooser } from '$/util/migration/domainMigration';
  import { PanZoomState } from '$/util/panZoom';
  import { inputStateStore, stateStore, updateCodeStore, urlsStore } from '$/util/state';
  import { logEvent, logMermaidChartClick } from '$/util/stats';
  import { initHandler } from '$/util/util';
  import { onMount } from 'svelte';
  import CodeIcon from '~icons/custom/code';
  import HistoryIcon from '~icons/material-symbols/history';
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
  let isViewMode = $state(true);
  let showEditorChooser = $state(false);

  let isHistoryOpen = $state(false);
  let isCodeClosed = $state(false);

  let codeHistory = $state<string[]>([]);
  let historyIndex = $state(-1);
  let isNavigatingHistory = false;

  onMount(async () => {
    showEditorChooser = shouldShowEditorChooser();
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
    <div
      class={[
        'size-full',
        isMobile && ['w-[200%] duration-300', isViewMode && '-translate-x-1/2']
      ]}>
      <Resizable.PaneGroup
        direction="horizontal"
        autoSaveId="liveEditor"
        class="gap-4 p-2 pt-0 sm:gap-0 sm:p-6 sm:pt-0 relative">
        
        {#if !isCodeClosed}
          <Resizable.Pane bind:this={editorPane} defaultSize={15} minSize={5} maxSize={50}>
            <div class="flex h-full flex-col gap-4 sm:gap-6 pr-2">
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
          <Resizable.Handle class="w-2 bg-gray-200 hover:bg-gray-300 hidden sm:block cursor-col-resize transition-colors" />
        {/if}
        
        <Resizable.Pane minSize={15} class="relative flex h-full flex-1 flex-col overflow-hidden">
          <div class="absolute top-4 left-4 z-[60] flex gap-2">
            <Button 
              variant="outline" 
              size="sm" 
              class="bg-white shadow-md border-gray-300 text-gray-700 hover:bg-gray-50 rounded-md font-medium px-3 py-1.5 transition-all" 
              onclick={() => isCodeClosed = !isCodeClosed}
            >
              {isCodeClosed ? 'Show Code' : 'Hide Code'}
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              class="bg-white shadow-md border-gray-300 text-gray-700 hover:bg-gray-50 rounded-md font-medium px-3 py-1.5 transition-all disabled:opacity-50" 
              onclick={undo}
              disabled={historyIndex <= 0}
            >
              Undo
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              class="bg-white shadow-md border-gray-300 text-gray-700 hover:bg-gray-50 rounded-md font-medium px-3 py-1.5 transition-all disabled:opacity-50" 
              onclick={redo}
              disabled={historyIndex >= codeHistory.length - 1}
            >
              Redo
            </Button>
          </div>
          <View {panZoomState} shouldShowGrid={$stateStore.grid} />
        </Resizable.Pane>
      </Resizable.PaneGroup>
    </div>
  </div>
</div>
