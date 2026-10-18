export const categories = [
  { slug: 'art', name: 'Art', label: '作品・制作', description: '作品に向き合う時間や、制作の中で生まれた気づきを記録します。' },
  { slug: 'exhibition', name: 'Exhibition', label: '展示・企画', description: '展示の企画、準備、会場での出来事を記録します。' },
  { slug: 'creative', name: 'Creative', label: 'Web・AI・ものづくり', description: 'WebデザインやAIを使った制作の過程を記録します。' },
] as const;

export type BlogCategory = (typeof categories)[number];
