<script lang="ts">
  import { Button } from '$/components/ui/button';
  import { waitForRender } from '$lib/util/autoSync';
  import { inputStateStore, stateStore } from '$lib/util/state';
  import { logEvent } from '$lib/util/stats';
  import { version as FAVersion } from '@fortawesome/fontawesome-free/package.json';
  import dayjs from 'dayjs';
  import { toBase64 } from 'js-base64';
  import DownloadIcon from '~icons/material-symbols/download';

  const FONT_AWESOME_URL = `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/${FAVersion}/css/all.min.css`;

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
<?xml-stylesheet href="${FONT_AWESOME_URL}" type="text/css"?>
${svgString}`);
  };

  const onDownloadSVG = () => {
    simulateDownload(getFileName('svg'), `data:image/svg+xml;base64,${getBase64SVG()}`);
    logEvent('download', { type: 'svg' });
  };

  const onDownloadPNG = async () => {
    $inputStateStore.panZoom = false;
    await new Promise((r) => setTimeout(r, 600));
    await waitForRender();

    const svg = document.querySelector<HTMLElement>('#container svg');
    if (!svg) return;

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
    if (!ctx) return;
    ctx.fillStyle = window.getComputedStyle(document.body).getPropertyValue('--background');
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const image = new Image();
    image.onload = () => {
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      simulateDownload(
        getFileName('png'),
        canvas.toDataURL('image/png').replace('image/png', 'image/octet-stream')
      );
      $inputStateStore.panZoom = true;
    };
    image.src = `data:image/svg+xml;base64,${getBase64SVG(svg, canvas.width, canvas.height)}`;
    setTimeout(() => {
      if (!$inputStateStore.panZoom) $inputStateStore.panZoom = true;
    }, 2000);

    logEvent('download', { type: 'png' });
  };

  const onDownloadMMD = () => {
    const code = $inputStateStore.code ?? '';
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    simulateDownload(getFileName('mmd'), url);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    logEvent('download', { type: 'mmd' });
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
    disabled={hasError}
    class="flex items-center gap-1.5 rounded-md border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 shadow-md transition-all hover:bg-gray-50 disabled:opacity-40"
    onclick={onDownloadPNG}>
    <DownloadIcon class="size-3.5" />
    PNG
  </Button>
</div>
