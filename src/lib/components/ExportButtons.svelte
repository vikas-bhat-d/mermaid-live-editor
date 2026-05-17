<script lang="ts">
  import { Button } from '$/components/ui/button';
  import { waitForRender } from '$lib/util/autoSync';
  import { inputStateStore, stateStore } from '$lib/util/state';
  import dayjs from 'dayjs';
  import { toBase64 } from 'js-base64';
  import DownloadIcon from '~icons/material-symbols/download';

  let isDownloadingPNG = $state(false);

  const getFileName = (ext: string) =>
    `mermaid-diagram-${dayjs().format('YYYY-MM-DD-HHmmss')}.${ext}`;

  const simulateDownload = (download: string, href: string) => {
    const a = document.createElement('a');
    a.download = download;
    a.href = href;
    a.click();
    a.remove();
  };

  const getSvgElement = (): HTMLElement => {
    const el = document.querySelector('#container svg')?.cloneNode(true) as HTMLElement;
    el.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    return el;
  };

  const getBase64SVG = (svg?: HTMLElement, width?: number, height?: number): string => {
    if (!svg) svg = getSvgElement();
    else svg = svg.cloneNode(true) as HTMLElement;
    if (width) svg.setAttribute('width', `${width}px`);
    if (height) svg.setAttribute('height', `${height}px`);
    svg.style.backgroundColor = window
      .getComputedStyle(document.body)
      .getPropertyValue('--background');
    const svgString = svg.outerHTML
      .replaceAll('<br>', '<br/>')
      .replaceAll(/<img([^>]*)>/g, (_m, g: string) => `<img ${g} />`);
    return toBase64(`<?xml version="1.0" encoding="UTF-8"?>
${svgString}`);
  };

  const onDownloadSVG = () => {
    simulateDownload(getFileName('svg'), `data:image/svg+xml;base64,${getBase64SVG()}`);
  };

  const onDownloadPNG = async () => {
    console.log('png download started');
    isDownloadingPNG = true;
    $inputStateStore.panZoom = false;
    try {
      // Wait for pan/zoom state to take effect (fullscreen layout)
      await new Promise((r) => setTimeout(r, 600));
      console.log('after first wait');

      // Wait for render to complete, with a 2-second timeout to avoid hanging
      const renderTimeout = new Promise((resolve) => setTimeout(resolve, 2000));
      await Promise.race([waitForRender(), renderTimeout]);
      console.log('rendered');

      const svg = document.querySelector<HTMLElement>('#container svg');
      if (!svg) {
        console.error('SVG element not found');
        return;
      }
      console.log('svg found');

      const svgEl = svg as unknown as SVGSVGElement;
      const box = svg.getBoundingClientRect();
      const vb = svgEl.viewBox?.baseVal;
      const w = vb && vb.width > 0 ? vb.width : box.width;
      const h = vb && vb.height > 0 ? vb.height : box.height;

      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        console.error('canvas context not found');
        return;
      }
      ctx.fillStyle = window.getComputedStyle(document.body).getPropertyValue('--background');
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Build SVG string and load via data URL (simpler, less taint issues)
      const svgBase64 = getBase64SVG(svg, canvas.width, canvas.height);
      console.log('svg base64 created, length:', svgBase64.length);

      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        const imageTimeout = setTimeout(() => {
          reject(new Error('Image loading timeout after 5 seconds'));
        }, 5000);

        image.onload = () => {
          clearTimeout(imageTimeout);
          try {
            console.log('image loaded, drawing to canvas');
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

            // Convert canvas to data URL immediately after drawing
            // (avoids some taint issues by not using toBlob)
            console.log('converting canvas to PNG data URL');
            const dataUrl = canvas.toDataURL('image/png');
            console.log('data url created, length:', dataUrl.length);

            // Convert data URL to blob for better download handling
            fetch(dataUrl)
              .then((res) => res.blob())
              .then((blob) => {
                console.log('blob created from data url');
                const url = URL.createObjectURL(blob);
                console.log('download url created:', url);
                simulateDownload(getFileName('png'), url);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                resolve();
              })
              .catch((err) => {
                console.warn('fetch/blob failed, using data URL directly:', err);
                // Last resort: use data URL directly
                simulateDownload(getFileName('png'), dataUrl);
                resolve();
              });
          } catch (err) {
            reject(err);
          }
        };

        image.onerror = () => {
          clearTimeout(imageTimeout);
          reject(new Error('SVG failed to load as image'));
        };

        // Use data URL directly (more reliable than blob URLs for SVG)
        image.crossOrigin = 'anonymous';
        console.log('setting image src to data URL');
        image.src = `data:image/svg+xml;base64,${svgBase64}`;
      });
      console.log('png download completed');
    } catch (err) {
      console.error('PNG download error:', err);
    } finally {
      console.log('finally called, restoring panZoom');
      isDownloadingPNG = false;
      $inputStateStore.panZoom = true;
    }
  };

  const onDownloadMMD = () => {
    const code = $inputStateStore.code ?? '';
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    simulateDownload(getFileName('mmd'), url);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // Disable export buttons when diagram has an error
  const hasError = $derived(!!$stateStore.error);
</script>

<div class="flex gap-1.5">
  <Button
    variant="outline"
    size="sm"
    class="flex items-center gap-1.5 rounded-md border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 shadow-md transition-all hover:bg-gray-50"
    onclick={onDownloadMMD}>
    <DownloadIcon class="size-3.5" />
    MMD
  </Button>
  <Button
    variant="outline"
    size="sm"
    disabled={hasError}
    class="flex items-center gap-1.5 rounded-md border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 shadow-md transition-all hover:bg-gray-50 disabled:opacity-40"
    onclick={onDownloadSVG}>
    <DownloadIcon class="size-3.5" />
    SVG
  </Button>
  <Button
    variant="outline"
    size="sm"
    disabled={hasError || isDownloadingPNG}
    class="flex items-center gap-1.5 rounded-md border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 shadow-md transition-all hover:bg-gray-50 disabled:opacity-40"
    onclick={onDownloadPNG}>
    {#if isDownloadingPNG}
      <svg
        class="size-3.5 animate-spin"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
        ></circle>
        <path
          class="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        ></path>
      </svg>
    {:else}
      <DownloadIcon class="size-3.5" />
    {/if}
    PNG
  </Button>
</div>
