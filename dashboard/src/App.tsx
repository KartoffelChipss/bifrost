import { Route, Routes } from 'react-router-dom';
import { Home } from '@/pages/Home';
import { GuildDetail } from '@/pages/GuildDetail';
import { Admin } from '@/pages/Admin';

function App() {
    return (
        <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/guilds/:guildLinkId" element={<GuildDetail />} />
            <Route path="/admin" element={<Admin />} />
        </Routes>
    );
}

export default App;
