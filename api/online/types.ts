// api/online/types.ts
export interface Me {
  id?: number;
  username: string;
  slug?: string;
  avatar_url?: string;
  profile_url?: string;
}

export interface UserComment {
  id: number;
  gallery_id: number;
  body: string;
  post_date?: number; // unix seconds
  avatar_url?: string;
  page_url?: string; // /g/<id>/#comment-<id>
}

export interface UserOverview {
  me: Me;
  joinedText?: string;
  favoriteTags?: string[];
  favoriteTagsText?: string;
  about?: string;
  recentFavoriteIds: number[];
  recentComments: UserComment[];
}
