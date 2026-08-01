import React from "react";

interface State {
  error: Error | null;
  copied: boolean;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private handleReload = () => {
    location.reload();
  };

  private handleHome = () => {
    this.setState({ error: null, copied: false });
    window.location.href = "/";
  };

  private handleCopy = async () => {
    const { error } = this.state;
    if (!error) return;
    const text = `${error.message}\n\n${error.stack}`;
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      // Clipboard API may fail — fallback to selection
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    }
  };

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        className="dark"
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg)",
          color: "var(--ink)",
          fontFamily: "var(--font)",
          zIndex: 9999,
        }}
      >
        <div
          style={{
            maxWidth: 480,
            padding: 32,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 40,
              marginBottom: 16,
            }}
          >
            ⚠
          </div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            Something went wrong
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--ink2)",
              lineHeight: 1.5,
              marginBottom: 16,
            }}
          >
            An unexpected error occurred. You can reload the page or go back to
            the library.
          </div>
          <pre
            style={{
              textAlign: "left",
              fontSize: 11,
              fontFamily: "var(--mono)",
              color: "var(--err)",
              background: "var(--errBg)",
              border: "1px solid var(--l2)",
              borderRadius: 4,
              padding: 12,
              marginBottom: 16,
              maxHeight: 200,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {error.message}
            {"\n\n"}
            {error.stack}
          </pre>
          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "center",
            }}
          >
            <button className="btn" onClick={this.handleCopy}>
              {copied ? "Copied!" : "Copy error"}
            </button>
            <button className="btn" onClick={this.handleHome}>
              Go to Library
            </button>
            <button className="btn accent" onClick={this.handleReload}>
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
