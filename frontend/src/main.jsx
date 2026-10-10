import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import TorqvaApp from './torqva/TorqvaApp.jsx';
import './index.css';

// The root route (/) is the TORQVA software application (simulation mode, no hardware needed).
// The previous hardware-oriented dashboard is kept, unchanged, at  /#/legacy
const isLegacy = () => window.location.hash.startsWith('#/legacy');

function Root() {
  const [legacy, setLegacy] = React.useState(isLegacy());
  React.useEffect(() => {
    const on = () => setLegacy(isLegacy());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return legacy ? <App /> : <TorqvaApp />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
