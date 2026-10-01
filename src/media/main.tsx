import { createRoot } from 'react-dom/client';
import { MergePage } from './MergePage';
import './merge.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(<MergePage />);
