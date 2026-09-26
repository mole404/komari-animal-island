import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import 'animal-island-ui/style';
import App from './App';
import './theme.css';

/** 根级错误边界：渲染异常时给出友好提示，避免整页白屏（不引入新依赖）。 */
class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[animal-island] 页面渲染异常', error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="root-error-fallback" role="alert">
          <h1>岛屿暂时无法显示</h1>
          <p>页面渲染出现异常，请刷新后重试。</p>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
