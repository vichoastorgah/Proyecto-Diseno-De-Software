import { BrowserRouter, Routes, Route } from "react-router-dom";
import { LanguageProvider } from "./context/LanguageContext";
import Navbar from "./components/Navbar";
import AdminView from "./pages/AdminView";
import SurveyView from "./pages/SurveyView";
import VotingView from "./pages/VotingView";

function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <Navbar />
        <Routes>
          <Route path="/admin" element={<AdminView />} />
          <Route path="/survey" element={<SurveyView />} />
          <Route path="/vote" element={<VotingView />} />
        </Routes>
      </BrowserRouter>
    </LanguageProvider>
  );
}

export default App;