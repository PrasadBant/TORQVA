import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import TorqvaApp from './torqva/TorqvaApp.jsx';
import './index.css';

// The legacy dashboard stays the default. The TORQVA workspace lives at  /#/torqva
const isTorqva = () => window.location.hash.startsWith('#/torqva');

function Root() {
  const [torqva, setTorqva] = React.useState(isTorqva());
  React.useEffect(() => {
    const on = () => setTorqva(isTorqva());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return torqva ? <TorqvaApp /> : <App />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
