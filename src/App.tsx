import { useEffect, useState } from 'react';
import { openRepo, showError } from './actions';
import { useApp } from './store';
import { ContextMenuHost } from './ui/ContextMenu';
import { DialogHost } from './ui/Dialog';
import { ToastHost } from './ui/Toasts';
import { Welcome } from './views/Welcome';
import { Workspace } from './views/Workspace';

export function App() {
  const repoPath = useApp((s) => s.repoPath);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const p = new URLSearchParams(location.search).get('repo');
    if (!p) return setBooting(false);
    openRepo(p)
      .catch((e) => showError('无法打开仓库', e))
      .finally(() => setBooting(false));
  }, []);

  return (
    <>
      {repoPath ? <Workspace /> : booting ? <div className="boot muted">正在打开仓库…</div> : <Welcome />}
      <ContextMenuHost />
      <DialogHost />
      <ToastHost />
    </>
  );
}
