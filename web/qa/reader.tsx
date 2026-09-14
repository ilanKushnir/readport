// Browser regression fixture only; not imported by the application entry point.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ReaderPage } from '../src/reader/ReaderPage';
import { ToastProvider } from '../src/components/ui';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/immersive.css';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <ToastProvider>
      <Routes>
        <Route path="/__reader-qa/:id" element={<ReaderPage />} />
      </Routes>
    </ToastProvider>
  </BrowserRouter>,
);
