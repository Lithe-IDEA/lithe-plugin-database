import { render } from 'preact';
import { loadWorkspace, persistPageState } from './actions.ts';
import { App } from './components/App.tsx';

render(<App />, document.getElementById('app')!);
persistPageState();
void loadWorkspace();
