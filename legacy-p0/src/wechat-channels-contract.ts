export const WECHAT_CHANNELS_ACCOUNT = {
  displayName: "山石ly的视频号",
  accountId: "sph42vLa6y4BW9x",
  collection: "来越企业全知道"
} as const;

export const WECHAT_CHANNELS_PHASES = [
  "SESSION_CHECK",
  "ACCOUNT_VERIFIED",
  "EDITOR_READY",
  "UPLOADING",
  "UPLOAD_COMPLETE",
  "FORM_VERIFIED",
  "SUBMIT_CLICKED",
  "READBACK_PENDING",
  "READBACK_CONFIRMED",
  "READBACK_AMBIGUOUS"
] as const;

export type WechatChannelsPhase = typeof WECHAT_CHANNELS_PHASES[number];

export type WechatChannelsReadback = {
  beforeCount?: number;
  afterCount?: number;
  itemStatus?: string;
  visibleTitle?: string;
  expectedTitle: string;
};

export type WechatChannelsReadbackDecision = {
  outcome: "PUBLISHED_ID_PENDING" | "RECONCILE_PENDING" | "CONFIRMED_ABSENT";
  phase: "READBACK_CONFIRMED" | "READBACK_AMBIGUOUS";
  mayRetry: false;
  evidence: string[];
};

/**
 * Decide publication truth from the independent list/history surface.
 * Upload progress, a submit click, toast text, or navigation alone are not accepted.
 */
export function decideWechatChannelsReadback(input: WechatChannelsReadback): WechatChannelsReadbackDecision {
  const evidence: string[] = [];
  const countIncremented = Number.isInteger(input.beforeCount) && Number.isInteger(input.afterCount)
    && input.afterCount! > input.beforeCount!;
  const titleMatches = Boolean(input.visibleTitle?.trim()) && input.visibleTitle!.trim() === input.expectedTitle.trim();
  const publishedMarker = /已发表|已发布/u.test(input.itemStatus ?? "");

  if (countIncremented) evidence.push(`video_count:${input.beforeCount}->${input.afterCount}`);
  if (titleMatches) evidence.push(`title:${input.visibleTitle}`);
  if (publishedMarker) evidence.push(`status:${input.itemStatus}`);

  if ((countIncremented && titleMatches) || (publishedMarker && titleMatches)) {
    return { outcome: "PUBLISHED_ID_PENDING", phase: "READBACK_CONFIRMED", mayRetry: false, evidence };
  }
  return {
    outcome: "RECONCILE_PENDING",
    phase: "READBACK_AMBIGUOUS",
    mayRetry: false,
    evidence: evidence.length ? evidence : ["no_authoritative_list_readback"]
  };
}

export type ChannelsVideoCard = { description: string; time: string; text: string };
export function channelsControlDisabled(input:{nativeDisabled:boolean;ariaDisabled?:string|null;className?:string|null}):boolean {
  return input.nativeDisabled || input.ariaDisabled==='true' || /(?:^|\s)(?:weui-desktop-btn_disabled|is-disabled|disabled)(?:\s|$)/u.test(input.className||'');
}

export function decideChannelsDescriptionReadback(input:{cards:ChannelsVideoCard[];expectedDescription:string;afterCount?:number;allowConclusiveAbsence?:boolean}):WechatChannelsReadbackDecision {
  const normalize=(s:string)=>s.replace(/\s+/gu,' ').trim();
  const cards=[...new Map(input.cards.map(card=>[`${normalize(card.description)}|${card.time}`,card])).values()];
  const expected=normalize(input.expectedDescription);
  const candidates=cards.filter(card=>{
    const actual=normalize(card.description).replace(/[.…]+$/gu,'').trim();
    return !!actual && (actual===expected || (actual.length>=30&&expected.startsWith(actual)));
  });
  const complete=Number.isInteger(input.afterCount)&&input.afterCount!>0&&cards.length===input.afterCount;
  const evidence=[`own_video_list_cards:${cards.length}`,`own_video_list_total:${input.afterCount??'unknown'}`,`matching_descriptions:${candidates.length}`];
  // A matching pending/rejected/ambiguous item still exists and must never be
  // converted into absence or permission to submit another copy.
  const published=candidates.filter(card=>card.time&&/修改描述和封面|已发表|已发布/u.test(card.text)&&!/发表中|审核中|待审核|发布失败|发表失败/u.test(card.text));
  if(candidates.length===1&&published.length===1)return {outcome:'PUBLISHED_ID_PENDING',phase:'READBACK_CONFIRMED',mayRetry:false,evidence:[...evidence,'managed_profile_own_video_list','own_video_list_exact_description','published_time:'+published[0].time,'published_management_controls']};
  if(input.allowConclusiveAbsence&&complete&&candidates.length===0)return {outcome:'CONFIRMED_ABSENT',phase:'READBACK_CONFIRMED',mayRetry:false,evidence:[...evidence,`complete_own_video_list:${cards.length}/${input.afterCount}`,'exact_description_absent']};
  return {outcome:'RECONCILE_PENDING',phase:'READBACK_AMBIGUOUS',mayRetry:false,evidence:[...evidence,candidates.length?'matching_item_not_confirmed_published':'exact_description_not_found']};
}

/** Only a platform-rendered total can prove complete coverage; DOM card count cannot. */
export function parseChannelsVideoTotal(text:string):number|undefined {
  for(const pattern of [/视频\s*[（(]\s*(\d+)\s*[）)]/u,/共\s*(\d+)\s*个?视频/u]){
    const match=text.match(pattern);if(match)return Number(match[1]);
  }
  return undefined;
}
