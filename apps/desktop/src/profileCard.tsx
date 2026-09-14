/**
 * 第 14 步：登录页的**第二种形态** —— 这台电脑登过这个号时，不再让人重填验证码，
 * 而是先出一张个人卡片，点一下「进入工作台」就进去。
 *
 * 结构按用户给的那张参考图靠拢（顶部横幅 + 头像压边 + 名称/简介 + 一排数字 + 右侧一个主按钮），
 * 精细皮肤留到以后。明确不做：多智能体员工、招聘/切换智能体、习惯学习、打分模型。
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { AuthSession } from '@ai-workbench/shared';
import {
  avatarDataUrl,
  formatDuration,
  initialOf,
  loadLocalProfile,
  updateLocalProfile,
  usageScore,
  type LocalProfile,
} from './localProfile';

interface Props {
  session: AuthSession;
  /** 一点就进工作台（不用再填验证码） */
  onEnter: () => void;
  /** 回到手机号 + XYZ 验证码登录；登完换成新号的卡片 */
  onSwitchAccount: () => void;
}

export function ProfileCard({ session, onEnter, onSwitchAccount }: Props) {
  const xyz = session.user.xyz_id;
  /** 卡片上可改的三样：名称 / 简介 / 头像。都按 XYZ 号记在本机。 */
  const [profile, setProfile] = useState<LocalProfile>(() => loadLocalProfile(xyz));
  /** 时长在 App 里一直累加，这里定期回读一次，免得数字停在进卡片那一刻 */
  const [usedMs, setUsedMs] = useState(() => loadLocalProfile(xyz).usedMs);
  const [note, setNote] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setUsedMs(loadLocalProfile(xyz).usedMs), 5000);
    return () => window.clearInterval(timer);
  }, [xyz]);

  /** 改一处就写一处（写穿到本机），所以「关掉再开」一定还在，不需要额外的保存按钮 */
  const patch = (p: Partial<Omit<LocalProfile, 'xyz'>>) => {
    const next = updateLocalProfile(xyz, p);
    setProfile(next);
    if (typeof p.usedMs === 'number') setUsedMs(next.usedMs);
  };

  const onPickAvatar = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许连续选同一张图
    if (!file) return;
    setNote('');
    try {
      patch({ avatar: await avatarDataUrl(file) });
      setNote('头像已换好（只存在这台电脑上，跟着这个号记住）。');
    } catch (err) {
      setNote(`换头像失败：${(err as Error).message}`);
    }
  };

  const agents = session.agents;
  const agentName = agents[0]?.name || '小助';
  /** 提示词钉死：目前只展示 小助 × 1，不做多个员工、不做招聘/切换 */
  const agentCount = agents.length || 1;
  const score = usageScore(usedMs);

  return (
    <div className="profileWrap">
      <div className="profileCard">
        <div className="profileCard__cover" aria-hidden="true" />

        <div className="profileCard__body">
          {/* 头像压在横幅下沿；右侧信息栏里带 XYZ 号（只展示，不当名称改） */}
          <div className="profileCard__head">
            <div className="profileCard__avatarWrap">
              <div className="profileCard__avatar">
                {profile.avatar ? (
                  <img src={profile.avatar} alt="我的头像" />
                ) : (
                  <span aria-hidden="true">{initialOf(profile.displayName)}</span>
                )}
              </div>
              <input ref={fileRef} className="profileCard__file" type="file" accept="image/*" onChange={(e) => void onPickAvatar(e)} />
              <button type="button" className="profileCard__avatarBtn" onClick={() => fileRef.current?.click()}>
                换头像
              </button>
            </div>

            <div className="profileCard__idBar">
              <span className="profileCard__chip profileCard__chip--id">我的号 {xyz}</span>
              {session.user.phone_masked && <span className="profileCard__chip">{session.user.phone_masked}</span>}
            </div>
          </div>

          {/* 名称 / 简介：直接可改，改完即存本机 */}
          <input
            className="profileCard__name"
            value={profile.displayName}
            maxLength={24}
            aria-label="名称"
            placeholder="名称"
            onChange={(e) => patch({ displayName: e.target.value })}
          />
          <input
            className="profileCard__bio"
            value={profile.bio}
            maxLength={60}
            aria-label="简介"
            placeholder="写一句简介（可改，跟着这个账号记住）"
            onChange={(e) => patch({ bio: e.target.value })}
          />

          <div className="profileCard__meta">
            <span className="profileCard__dot" aria-hidden="true" />
            {session.project?.name ? `${session.project.name} · ` : ''}AI 智能体员工 {agentName} × {agentCount}
          </div>

          <div className="profileCard__foot">
            <div className="profileCard__stats">
              <div className="profileCard__stat">
                <div className="profileCard__statNum">{formatDuration(usedMs)}</div>
                <div className="profileCard__statLabel">使用时长</div>
              </div>
              <div className="profileCard__stat">
                <div className="profileCard__statNum">{score}</div>
                <div className="profileCard__statLabel">学习 AI 的分数</div>
              </div>
              <div className="profileCard__stat">
                <div className="profileCard__statNum">
                  {agentName} × {agentCount}
                </div>
                <div className="profileCard__statLabel">智能体员工</div>
              </div>
            </div>

            <div className="profileCard__actions">
              <button type="button" className="btn btn--go profileCard__enter" onClick={onEnter}>
                进入工作台
              </button>
              <button type="button" className="profileCard__switch" onClick={onSwitchAccount}>
                切换账号
              </button>
            </div>
          </div>

          <div className="small profileCard__note">
            {note || `这台电脑已经登过 ${xyz}，一点就进，不用再填验证码。`}
          </div>
        </div>
      </div>
    </div>
  );
}
