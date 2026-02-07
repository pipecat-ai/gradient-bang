import { Component, type ReactNode } from "react"

type ErrorBoundaryFallback = (error: Error, reset: () => void) => ReactNode

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ErrorBoundaryFallback | ReactNode
  resetKey?: unknown
  onError?: (error: Error, info: { componentStack: string }) => void
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    this.props.onError?.(error, info)
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private reset = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (error) {
      const { fallback } = this.props
      if (typeof fallback === "function") {
        return fallback(error, this.reset)
      }
      return fallback ?? null
    }

    return this.props.children
  }
}

