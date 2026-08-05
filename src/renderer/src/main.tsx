import ReactDOM from 'react-dom/client'
import App from './App'
import '@xterm/xterm/css/xterm.css'
import 'dockview/dist/styles/dockview.css'
import './styles/index.css'

// Deliberately not wrapped in StrictMode: the double mount/unmount cycle would
// tear down and rebuild every xterm instance and its PTY attachment in dev.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
