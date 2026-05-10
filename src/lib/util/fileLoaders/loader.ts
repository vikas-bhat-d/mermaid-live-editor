import type { State } from '$lib/types';
import { defaultState, sanitizeConfig, updateCodeStore } from '$lib/util/state';
import { fetchText } from '$lib/util/util';

export const loadDataFromUrl = async (): Promise<void> => {
  const searchParams = new URLSearchParams(window.location.search);
  let state: Partial<State> = defaultState;
  let loaded = false;
  const codeURL: string | undefined = searchParams.get('code') ?? undefined;
  const configURL: string | undefined = searchParams.get('config') ?? undefined;

  let code: string | undefined;
  const config = configURL ? await fetchText(configURL) : defaultState.mermaid;

  if (codeURL) {
    code = await fetchText(codeURL);
    loaded = true;
  }
  if (code) {
    if (!codeURL) {
      throw new Error('Code URL is not defined');
    }
    state = {
      code,
      loader: {
        config: {
          codeURL,
          configURL
        },
        type: 'files'
      },
      mermaid: config
    };
  }
  if (loaded) {
    state.mermaid = sanitizeConfig(state.mermaid || defaultState.mermaid);
    updateCodeStore({
      ...state,
      updateDiagram: true
    });
  }
};
