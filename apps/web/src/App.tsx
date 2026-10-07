import { useEffect, useState } from 'react';
import type { ReadinessResponse } from '@print-pantry/contracts';

export function App() {
  const [status, setStatus] = useState('Checking connection...');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/ready', { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as ReadinessResponse;
        if (!response.ok || result.status !== 'ready') throw new Error('Service unavailable');
        setStatus('Connected');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('Service unavailable');
      });
    return () => controller.abort();
  }, []);

  return <main>
    <span className="eyebrow">Your 3D print library</span>
    <h1>Print Pantry</h1>
    <p>A cozy home for your projects and print requests.</p>
    <p role="status" className="status">API: {status}</p>
    <p className="hint">The catalog and request queue are coming in later phases.</p>
  </main>;
}
