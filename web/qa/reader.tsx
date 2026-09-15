// Browser regression fixture only; not imported by the application entry point.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ReaderPage } from '../src/reader/ReaderPage';
import { ToastProvider } from '../src/components/ui';
import { claimProgressQueue } from '../src/progress/engine';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/immersive.css';

/**
 * Somebody has to be signed in for progress to be recorded at all.
 *
 * Queued checkpoints belong to the account that made them: the engine writes
 * and delivers nothing until a session has been confirmed, so that a browser
 * shared between two people can never adopt - or publish - the first one's
 * reading positions under the second one's name. The application claims the
 * queue in SessionProvider, from /api/auth/me; this fixture mounts the reader
 * on its own, so it claims for a fixture account here. Without it the reader
 * still reads, and every checkpoint it makes is dropped on the floor.
 */
void claimProgressQueue('qa-fixture-user');

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <ToastProvider>
      <Routes>
        <Route path="/__reader-qa/:id" element={<ReaderPage />} />
      </Routes>
    </ToastProvider>
  </BrowserRouter>,
);
