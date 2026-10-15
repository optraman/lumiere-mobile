import { moviesFeed } from '../../src/api/feed';
import { FeedScreen } from '../../src/components/FeedScreen';

export default function MoviesTab() {
  return <FeedScreen load={moviesFeed} tab="movies" />;
}
