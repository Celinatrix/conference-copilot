import type { MetadataRoute } from 'next';

// Lets phones install the app to the home screen: own icon, full screen, no browser bar.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Conference AI Copilot',
    short_name: 'Copilot',
    description: 'Dịch hội nghị sang tiếng Việt và gợi ý trả lời từ tài liệu của bạn',
    start_url: '/conferences',
    display: 'standalone',
    background_color: '#05080f',
    theme_color: '#05080f',
    lang: 'vi',
    icons: [{ src: '/apple-icon', sizes: '180x180', type: 'image/png' }],
  };
}
