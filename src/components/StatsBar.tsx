type Stats = {
  seated: number;
  capacity: number;
  emptySeats: number;
  totalGuests: number;
  adultCount: number;
  childCount: number;
  unassignedCount: number;
  suggestedTables: number;
};

export default function StatsBar({ stats }: { stats: Stats }) {
  return (
    <div className="stats-bar">
      <div className="stat-item">名单总人数: <b>{stats.totalGuests}</b></div>
      <div className="stat-item">成人席位: <b>{stats.adultCount}</b></div>
      <div className="stat-item">儿童椅: <b>{stats.childCount}</b></div>
      {stats.totalGuests > 0 && (
        <div className="stat-item stat-suggest">
          按人数需桌数: <b>{stats.suggestedTables}</b> 桌{stats.capacity === 0 ? '（画布上还没摆桌）' : ''}
        </div>
      )}
      <div className="stat-item">已入座: <b>{stats.seated}</b></div>
      <div className="stat-item">空座位: <b>{stats.emptySeats}</b></div>
      <div className="stat-item">未分配:{' '}
        <b style={{ color: stats.unassignedCount > 0 ? '#c0392b' : 'inherit' }}>
          {stats.unassignedCount}
        </b>
      </div>
      {stats.capacity > 0 && <div className="stat-item">画布总容量: <b>{stats.capacity}</b></div>}
    </div>
  );
}
