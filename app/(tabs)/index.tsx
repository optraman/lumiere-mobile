import { homeFeed } from '../../src/api/feed';
import { FeedScreen } from '../../src/components/FeedScreen';
import { HomeShelf } from '../../src/components/HomeShelf';

/** Главная: наверху — свои списки плитками (как у Spotify), карусель — только в «Фильмах» и «Сериалах». */
export default function HomeTab() {
  return <FeedScreen load={homeFeed} tab="index" shelf={<HomeShelf />} />;
}
