import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ModeProvider } from './mode'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ModeProvider>
        <App />
      </ModeProvider>
    </BrowserRouter>
  </StrictMode>,
)
