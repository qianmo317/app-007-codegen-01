type Stats = {
  seated: number;
  capacity: number;
  emptySeats: number;
  totalGuests: number;
  totalHeads: number;
  children: number;
  unassignedCount: number;
};

export default function StatsBar({ stats }: { stats: Stats }) {
  return (
    <div className="stats-bar">
      <div className="stat-item">总人头: <b>{stats.totalHeads}</b></div>
      <div className="stat-item">宾客条目: <b>{stats.totalGuests}</b></div>
      {stats.children > 0 && <div className="stat-item">其中小孩: <b>{stats.children}</b></div>}
      <div className="stat-item">已入座: <b>{stats.seated}</b></div>
      <div className="stat-item">空座位: <b>{stats.emptySeats}</b></div>
      <div className="stat-item">未分配: <b style={{ color: stats.unassignedCount > 0 ? '#c0392b' : 'inherit' }}>{stats.unassignedCount}</b></div>
      <div className="stat-item">总容量: <b>{stats.capacity}</b></div>
    </div>
  );
}
