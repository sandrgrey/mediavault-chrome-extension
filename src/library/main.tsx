import { createRoot } from 'react-dom/client';
import { App } from './App';

const element = document.getElementById('root');
if (element) createRoot(element).render(<App />);
