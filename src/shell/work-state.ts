export function isVideoMutationStage(stage: string): boolean {
  return /rendering with ffmpeg|rendering the agent's custom ffmpeg composition|checking rendered video|checking custom render|saving new version/i.test(stage);
}
