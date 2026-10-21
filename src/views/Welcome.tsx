import { useEffect, useState } from 'react';
import { ArrowUp, CloudDownload, Folder, FolderGit2, FolderOpen, FolderPlus, X } from 'lucide-react';
import type { FsListing, RecentRepo } from '../../shared/types';
import { api } from '../api';
import { openRepo, showError } from '../actions';
import { Modal, openDialog } from '../ui/Dialog';
import { cx } from '../util';

/** Server-side directory browser (the browser cannot pick folders by path). */
export function browseDirectory(title: string, initial?: string): Promise<string | null> {
  return openDialog<string | null>((done) => <DirBrowser title={title} initial={initial} done={done} />);
}

function DirBrowser({ title, initial, done }: { title: string; initial?: string; done: (v: string | null) => void }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [path, setPath] = useState(initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const load = (p?: string) =>
    api
      .listDir(p)
      .then((l) => {
        setListing(l);
        setPath(l.path);
        setError(null);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load(initial);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal
      title={title}
      onClose={() => done(null)}
      width={600}
      onSubmit={() => done(path)}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={() => done(null)}>
            取消
          </button>
          <button className="btn primary" onClick={() => done(path)}>
            选择此目录
          </button>
        </>
      }
    >
      <div className="form-row">
        <button className="icon-btn" title="上级目录" disabled={!listing?.parent} onClick={() => listing?.parent && load(listing.parent)}>
          <ArrowUp size={15} />
        </button>
        <input
          className="input grow mono"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void load(path);
            }
          }}
        />
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="dir-list">
        {listing?.entries.length === 0 && <div className="muted pad">没有子目录</div>}
        {listing?.entries.map((e) => (
          <div
            key={e.path}
            className="dir-row"
            onClick={() => load(e.path)}
            onDoubleClick={() => e.isRepo && done(e.path)}
            title={e.isRepo ? '双击打开此仓库' : undefined}
          >
            {e.isRepo ? <FolderGit2 size={15} className="c-accent" /> : <Folder size={15} className="folder-icon" />}
            <span className={cx('ellipsis', e.isRepo && 'bold')}>{e.name}</span>
            {e.isRepo && <span className="badge small">Git</span>}
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function cloneDialog() {
  return openDialog<void>((done) => <CloneForm done={done} />);
}

function CloneForm({ done }: { done: () => void }) {
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState(localStorage.getItem('gv.cloneParent') ?? '~/projects');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const guess = url.trim().replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') ?? '';
  const submit = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      localStorage.setItem('gv.cloneParent', parent);
      const info = await api.clone(url.trim(), parent, name.trim() || guess);
      done();
      await openRepo(info.root);
    } catch (e) {
      showError('克隆失败', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="从 URL 克隆仓库"
      onClose={done}
      onSubmit={submit}
      width={560}
      footer={
        <>
          {busy && <span className="muted small">正在克隆，可能需要一些时间…</span>}
          <span className="spacer" />
          <button className="btn" onClick={done}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !url.trim()} onClick={submit}>
            克隆
          </button>
        </>
      }
    >
      <div className="form">
        <label className="form-label">URL</label>
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/user/repo.git" />
        <label className="form-label">父目录</label>
        <div className="form-row">
          <input className="input grow mono" value={parent} onChange={(e) => setParent(e.target.value)} />
          <button
            className="btn"
            onClick={async () => {
              const p = await browseDirectory('选择父目录', parent);
              if (p) setParent(p);
            }}
          >
            浏览…
          </button>
        </div>
        <label className="form-label">目录名</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={guess || '仓库名称'} />
        <div className="muted small">需要认证的仓库请先在系统中配置好凭据（SSH 密钥或凭据管理器）。</div>
      </div>
    </Modal>
  );
}

export function Welcome() {
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.recent().then(setRecent).catch(() => undefined);
  }, []);

  const open = async (p: string) => {
    if (!p.trim()) return;
    setBusy(true);
    try {
      await openRepo(p.trim());
    } catch (e) {
      showError('无法打开仓库', e);
    } finally {
      setBusy(false);
    }
  };

  const init = async () => {
    const dir = await browseDirectory('选择要初始化为 Git 仓库的目录');
    if (!dir) return;
    try {
      const info = await api.init(dir);
      await openRepo(info.root);
    } catch (e) {
      showError('初始化失败', e);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-brand">
          <div className="logo">
            <FolderGit2 size={30} />
          </div>
          <div>
            <h1>Git View</h1>
            <div className="muted">IDEA 风格的 Git 仓库可视化管理工具</div>
          </div>
        </div>
        <div className="welcome-grid">
          <div className="welcome-recent">
            <div className="section-title">最近打开</div>
            {recent.length === 0 && <div className="muted pad">暂无记录</div>}
            {recent.map((r) => (
              <div key={r.path} className="recent-row" onClick={() => open(r.path)}>
                <div className="recent-icon">{r.name.slice(0, 2).toUpperCase()}</div>
                <div className="grow ellipsis">
                  <div className="bold ellipsis">{r.name}</div>
                  <div className="muted small ellipsis">{r.path}</div>
                </div>
                <button
                  className="icon-btn"
                  title="从列表移除"
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.removeRecent(r.path).then(() => setRecent(recent.filter((x) => x.path !== r.path)));
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="welcome-actions">
            <div className="section-title">打开仓库</div>
            <div className="form-row">
              <input
                className="input grow mono"
                placeholder="仓库路径，例如 ~/projects/my-app"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && open(path)}
              />
              <button className="btn primary" disabled={busy || !path.trim()} onClick={() => open(path)}>
                打开
              </button>
            </div>
            <button
              className="action-card"
              onClick={async () => {
                const p = await browseDirectory('选择 Git 仓库');
                if (p) await open(p);
              }}
            >
              <FolderOpen size={18} />
              <div>
                <b>浏览本地仓库…</b>
                <div className="muted small">在文件系统中选择一个 Git 仓库</div>
              </div>
            </button>
            <button className="action-card" onClick={() => cloneDialog()}>
              <CloudDownload size={18} />
              <div>
                <b>克隆仓库…</b>
                <div className="muted small">从 URL 获取远程仓库</div>
              </div>
            </button>
            <button className="action-card" onClick={init}>
              <FolderPlus size={18} />
              <div>
                <b>创建 Git 仓库…</b>
                <div className="muted small">在已有目录中执行 git init</div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
