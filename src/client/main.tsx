import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/primitives.css';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('The Dayriff app root is missing.');
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
