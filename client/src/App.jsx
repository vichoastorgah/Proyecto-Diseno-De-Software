import { BrowserRouter, Routes, Route } from "react-router-dom";
import AdminView from "./pages/AdminView";
import SurveyView from "./pages/SurveyView";
import VotingView from "./pages/VotingView";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin" element={<AdminView />} />
        <Route path="/survey" element={<SurveyView />} />
        <Route path="/vote" element={<VotingView />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;