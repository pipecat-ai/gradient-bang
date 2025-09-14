import React from 'react';
import { createRoot } from 'react-dom/client';
import { MapVisualization } from './components/MapVisualization';
import './css/map-demo.css';

const MapDemo: React.FC = () => {
  return (
    <div className="map-demo-container">
      <h1>Gradient Bang - Map Visualization Demo</h1>
      <MapVisualization
        nodeRenderMax={25}
        minNodeDistance={4}
        nodeRepulsion={16000}
      />
    </div>
  );
};

const root = document.getElementById('map-root');
if (root) {
  createRoot(root).render(<MapDemo />);
}