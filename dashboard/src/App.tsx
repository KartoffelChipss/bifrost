import { Route, Routes } from 'react-router-dom';
import { Home } from '@/pages/Home';
import { GuildDetail } from '@/pages/GuildDetail';

function App() {
    return (
        <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/guilds/:guildLinkId" element={<GuildDetail />} />
        </Routes>
    );
}

export default App;
